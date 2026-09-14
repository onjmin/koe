/**
 * Frame-level acoustic features used to locate mora boundaries.
 *
 * Everything downstream reasons in *frames* at a fixed 2 ms hop, so a frame
 * index doubles as a millisecond timestamp once multiplied by {@link HOP_MS}.
 * The analysis runs at 16 kHz regardless of the source rate: that is well past
 * the 4–8 kHz band where fricative noise lives, and keeps a 512-point FFT to
 * 32 ms — short enough to see a plosive burst, long enough to resolve F1.
 */

import { parseWav, resample, toMono, type WavData } from "../converter/wav.js";

/** Analysis rate. */
export const RATE = 16000;
/** Hop between frames, in milliseconds. */
export const HOP_MS = 2;

const HOP = (RATE * HOP_MS) / 1000; // 32 samples
const FFT_SIZE = 512; // 32 ms window
const BINS = FFT_SIZE / 2;
/** Pitch analysis runs on a ×2 decimation of the 16 kHz signal. */
const PITCH_DECIM = 2;
const PITCH_RATE = RATE / PITCH_DECIM; // 8 kHz
const PITCH_WIN = 512; // 64 ms — at least 4 periods at 70 Hz
const MIN_F0 = 70;
const MAX_F0 = 600;

export interface Frames {
	/** Number of frames. */
	n: number;
	/** Source duration in milliseconds. */
	durationMs: number;
	/** Short-time level in dBFS, −120 for digital silence. */
	rmsDb: Float32Array;
	/** {@link rmsDb} smoothed over ~30 ms, for threshold crossings. */
	smoothDb: Float32Array;
	/** Normalised autocorrelation peak, 0–1. Above ~0.5 reads as voiced. */
	voiced: Float32Array;
	/** Share of spectral energy above 4 kHz — high for /s/, /sh/, /ch/. */
	highRatio: Float32Array;
	/** Level of the >4 kHz band alone, in dB. Frication shows here first. */
	highDb: Float32Array;
	/** Noise floor of {@link highDb}, in dB. */
	highFloorDb: number;
	/** Positive spectral flux, normalised so its own median is 1. */
	flux: Float32Array;
	/** Median f0 of the voiced portion, in Hz (0 when nothing is voiced). */
	f0: number;
	/** Noise floor in dBFS, estimated from the quietest tenth of the file. */
	floorDb: number;
	/**
	 * Level of the quietest 50 ms in the file — a true noise floor, unlike
	 * {@link floorDb}, which a short recording's own voice can drag upwards.
	 * Used to trace an attack back past the point where it is merely audible.
	 */
	quietDb: number;
	/** Loudest smoothed frame, in dBFS. */
	peakDb: number;
}

/**
 * Offset from a frame's first sample to the middle of its analysis window.
 *
 * Every feature a frame carries describes the whole window, so the event it
 * reports actually happened around the window's centre. Ignoring that biases
 * every boundary half a window early — 16 ms here, which is large enough to
 * shift a preutterance audibly.
 */
const WINDOW_CENTRE_MS = (FFT_SIZE / 2 / RATE) * 1000;

/** Convert a *duration* in milliseconds to a count of frames. */
export function msToFrame(ms: number): number {
	return Math.round(ms / HOP_MS);
}

/** Convert a *duration* in frames to milliseconds. */
export function framesToMs(frames: number): number {
	return frames * HOP_MS;
}

/** Convert a frame *index* to the time in the signal that it describes. */
export function frameTimeMs(frame: number): number {
	return frame * HOP_MS + WINDOW_CENTRE_MS;
}

/** In-place iterative radix-2 FFT over split real/imaginary arrays. */
function fft(re: Float32Array, im: Float32Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wRe = Math.cos(ang);
		const wIm = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let curRe = 1;
			let curIm = 0;
			for (let k = 0; k < len >> 1; k++) {
				const aRe = re[i + k];
				const aIm = im[i + k];
				const bRe =
					re[i + k + (len >> 1)] * curRe - im[i + k + (len >> 1)] * curIm;
				const bIm =
					re[i + k + (len >> 1)] * curIm + im[i + k + (len >> 1)] * curRe;
				re[i + k] = aRe + bRe;
				im[i + k] = aIm + bIm;
				re[i + k + (len >> 1)] = aRe - bRe;
				im[i + k + (len >> 1)] = aIm - bIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
}

/**
 * Noise floor: the level of the quietest 50 ms in the file.
 *
 * A low percentile is the obvious estimator and the wrong one — a short,
 * quietly recorded mora can be more than 90 % voice, which drags a tenth-
 * percentile "floor" up into the consonant and hides the attack entirely.
 */
function quietestWindow(db: Float32Array): number {
	const averaged = smooth(db, Math.round(50 / HOP_MS));
	let min = Infinity;
	for (let i = 0; i < averaged.length; i++) {
		if (averaged[i] < min) min = averaged[i];
	}
	return Number.isFinite(min) ? min : -120;
}

function percentile(values: Float32Array, p: number): number {
	const sorted = Float32Array.from(values).sort();
	const i = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round(p * (sorted.length - 1))),
	);
	return sorted[i];
}

/**
 * Normalised cross-correlation of `buf` at `lag`, over `win` samples from
 * `at`. Returns a value in [-1, 1]; 1 means perfectly periodic at that lag.
 */
function ncc(buf: Float32Array, at: number, win: number, lag: number): number {
	let r = 0;
	let e0 = 0;
	let e1 = 0;
	for (let i = 0; i < win; i++) {
		const a = buf[at + i];
		const b = buf[at + i + lag];
		r += a * b;
		e0 += a * a;
		e1 += b * b;
	}
	const denom = Math.sqrt(e0 * e1);
	return denom > 1e-12 ? r / denom : 0;
}

/** Extract every feature the mora estimator needs from one mono signal. */
export function analyze(wav: WavData): Frames {
	const mono = resample(toMono(wav), RATE);
	const x = mono.samples;
	const n = Math.max(1, Math.floor((x.length - FFT_SIZE) / HOP) + 1);

	const rmsDb = new Float32Array(n);
	const highRatio = new Float32Array(n);
	const highDb = new Float32Array(n);
	const flux = new Float32Array(n);
	const voiced = new Float32Array(n);

	const window = new Float32Array(FFT_SIZE);
	for (let i = 0; i < FFT_SIZE; i++) {
		window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
	}

	const re = new Float32Array(FFT_SIZE);
	const im = new Float32Array(FFT_SIZE);
	const mag = new Float32Array(BINS);
	const prevMag = new Float32Array(BINS);
	// 4 kHz is the boundary between "voice" and "sibilant hiss" at this rate.
	const highBin = Math.floor((4000 / (RATE / 2)) * BINS);

	for (let t = 0; t < n; t++) {
		const off = t * HOP;
		let energy = 0;
		for (let i = 0; i < FFT_SIZE; i++) {
			const s = x[off + i] ?? 0;
			energy += s * s;
			re[i] = s * window[i];
			im[i] = 0;
		}
		rmsDb[t] = 10 * Math.log10(energy / FFT_SIZE + 1e-12);

		fft(re, im);

		let lowSum = 0;
		let highSum = 0;
		let fluxSum = 0;
		for (let b = 1; b < BINS; b++) {
			const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
			mag[b] = m;
			if (b < highBin) lowSum += m;
			else highSum += m;
			// Log-domain flux: a doubling counts the same whether the frame is
			// loud or quiet, so a consonant release inside a soft passage still
			// registers as an onset.
			const d = Math.log10(m + 1e-6) - Math.log10(prevMag[b] + 1e-6);
			if (d > 0) fluxSum += d;
		}
		prevMag.set(mag);
		highRatio[t] = highSum / (lowSum + highSum + 1e-12);
		highDb[t] = 20 * Math.log10(highSum / BINS + 1e-9);
		flux[t] = t === 0 ? 0 : fluxSum;
	}

	const smoothDb = smooth(rmsDb, Math.round(30 / HOP_MS));
	const smoothHighDb = smooth(highDb, Math.round(20 / HOP_MS));
	const highFloorDb = quietestWindow(smoothHighDb);
	const floorDb = percentile(smoothDb, 0.1);
	const quietDb = quietestWindow(smoothDb);
	let peakDb = -120;
	for (let t = 0; t < n; t++) if (smoothDb[t] > peakDb) peakDb = smoothDb[t];

	// --- pitch ---------------------------------------------------------------
	// Decimate for speed, then find the file's own f0 once and track only a
	// narrow lag band around it. A full search per frame would dominate runtime
	// and, on a single sustained note, buy nothing.
	const pitchBuf = new Float32Array(Math.floor(x.length / PITCH_DECIM));
	for (let i = 0; i < pitchBuf.length; i++) {
		pitchBuf[i] = (x[i * PITCH_DECIM] + x[i * PITCH_DECIM + 1]) * 0.5;
	}
	const minLag = Math.floor(PITCH_RATE / MAX_F0);
	const maxLag = Math.floor(PITCH_RATE / MIN_F0);

	const loud: number[] = [];
	for (let t = 0; t < n; t++) {
		if (smoothDb[t] > peakDb - 10) loud.push(t);
	}
	const lags: number[] = [];
	const step = Math.max(1, Math.floor(loud.length / 24));
	for (let k = 0; k < loud.length; k += step) {
		const at = Math.floor((loud[k] * HOP) / PITCH_DECIM);
		if (at + PITCH_WIN + maxLag >= pitchBuf.length) continue;
		let best = 0;
		let bestLag = 0;
		for (let lag = minLag; lag <= maxLag; lag++) {
			const v = ncc(pitchBuf, at, PITCH_WIN, lag);
			if (v > best) {
				best = v;
				bestLag = lag;
			}
		}
		if (best > 0.5 && bestLag > 0) lags.push(bestLag);
	}
	lags.sort((a, b) => a - b);
	const centreLag = lags.length ? lags[lags.length >> 1] : 0;
	const f0 = centreLag ? PITCH_RATE / centreLag : 0;

	if (centreLag) {
		const lo = Math.max(minLag, Math.floor(centreLag / 1.7));
		const hi = Math.min(maxLag, Math.ceil(centreLag * 1.7));
		for (let t = 0; t < n; t++) {
			// Silence is never voiced, and skipping it keeps the inner loop off
			// the long tails of room tone that bracket every recording.
			if (smoothDb[t] < floorDb + 6) continue;
			const at = Math.floor((t * HOP) / PITCH_DECIM);
			if (at + PITCH_WIN + hi >= pitchBuf.length) continue;
			let best = 0;
			for (let lag = lo; lag <= hi; lag++) {
				const v = ncc(pitchBuf, at, PITCH_WIN, lag);
				if (v > best) best = v;
			}
			voiced[t] = best;
		}
	}

	// Normalise flux by its own median so thresholds are scale-free.
	const medianFlux = percentile(flux, 0.5) || 1;
	for (let t = 0; t < n; t++) flux[t] /= medianFlux;

	return {
		n,
		durationMs: (x.length / RATE) * 1000,
		rmsDb,
		smoothDb,
		voiced,
		highRatio,
		highDb: smoothHighDb,
		highFloorDb,
		flux: smooth(flux, 3),
		f0,
		floorDb,
		quietDb,
		peakDb,
	};
}

/** Centred moving average over `width` frames, with shrinking edge windows. */
export function smooth(src: Float32Array, width: number): Float32Array {
	if (width <= 1) return Float32Array.from(src);
	const prefix = new Float64Array(src.length + 1);
	for (let i = 0; i < src.length; i++) prefix[i + 1] = prefix[i] + src[i];

	const out = new Float32Array(src.length);
	const half = width >> 1;
	for (let i = 0; i < src.length; i++) {
		const lo = Math.max(0, i - half);
		const hi = Math.min(src.length, i + half + 1);
		out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
	}
	return out;
}

/** Convenience wrapper: decode a WAV buffer and analyse it. */
export function analyzeWav(buf: ArrayBuffer): Frames {
	return analyze(parseWav(buf));
}
