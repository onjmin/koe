/**
 * UTAU `.frq` frequency-analysis files (FREQ0003). The same format OpenUtau
 * reads: an 8-byte header, hop size, the average fundamental frequency of the
 * whole recording, then a per-frame f0 / amplitude curve.
 *
 * Layout:
 *   char[8]  "FREQ0003"
 *   int32    hopSize      ← in ORIGINAL WAV samples
 *   float64  averageF0    ← whole-file average in Hz
 *   byte[16] (blank)
 *   int32    length
 *   { float64 f0, float64 amp } × length
 */

const HEADER_SIZE = 40;

export interface FrqData {
	/** Analysis hop in samples of the ORIGINAL wav (not the 48 kHz conversion) */
	hopSize: number;
	/** Whole-file average f0 in Hz, as stored in the header */
	averageF0: number;
	/** Per-frame f0 in Hz — 0 where the analyser found no clear pitch */
	f0: Float64Array;
	/** Per-frame amplitude, parallel to {@link f0} */
	amp: Float64Array;
}

/** Parse a `.frq` file, including the per-frame curve. Null if not FREQ0003. */
export function parseFrq(buffer: ArrayBuffer): FrqData | null {
	if (buffer.byteLength < HEADER_SIZE) return null;
	const view = new DataView(buffer);

	let header = "";
	for (let i = 0; i < 8; i++) header += String.fromCharCode(view.getUint8(i));
	if (header !== "FREQ0003") return null;

	const hopSize = view.getInt32(8, true);
	const averageF0 = view.getFloat64(12, true); // little-endian
	const declared = view.getInt32(36, true);
	// Trust the file's actual size over the declared count — truncated frq files
	// are common enough that reading past the buffer must not throw.
	const available = Math.floor((buffer.byteLength - HEADER_SIZE) / 16);
	const length = Math.max(0, Math.min(declared, available));

	const f0 = new Float64Array(length);
	const amp = new Float64Array(length);
	for (let i = 0; i < length; i++) {
		const p = HEADER_SIZE + i * 16;
		f0[i] = view.getFloat64(p, true);
		amp[i] = view.getFloat64(p + 8, true);
	}

	return {
		hopSize: hopSize > 0 ? hopSize : 256,
		averageF0: Number.isFinite(averageF0) && averageF0 > 0 ? averageF0 : 0,
		f0,
		amp,
	};
}

/**
 * Average f0 over the voiced frames covering a time span of the recording.
 *
 * The header's whole-file average includes leading silence and unvoiced
 * consonants, so it can sit well away from the pitch actually sounding in the
 * region a note is built from. Playback resamples the whole phoneme by one
 * scalar ratio, so an inaccurate value both detunes the note and makes two
 * crossfading notes drift apart in phase across the overlap — a 1% error at
 * 233 Hz drifts ~25° over a 30 ms overlap and ~84° over 100 ms.
 *
 * @param startMs / endMs  span within the ORIGINAL recording, in milliseconds
 * @param sourceRate       sample rate of the original WAV the frq describes
 * @returns Hz, or 0 when the span holds no voiced frames
 */
export function frqAverageF0InRange(
	frq: FrqData,
	startMs: number,
	endMs: number,
	sourceRate: number,
): number {
	if (!(sourceRate > 0) || frq.f0.length === 0) return 0;
	const perFrameMs = (frq.hopSize / sourceRate) * 1000;
	if (!(perFrameMs > 0)) return 0;

	const first = Math.max(0, Math.floor(startMs / perFrameMs));
	const last = Math.min(frq.f0.length - 1, Math.ceil(endMs / perFrameMs));

	// Amplitude-weighted so quiet fringe frames (a decaying tail, a breath)
	// don't pull the average away from the body of the vowel.
	let num = 0;
	let den = 0;
	for (let i = first; i <= last; i++) {
		const hz = frq.f0[i];
		if (!(hz > 0)) continue; // unvoiced / undetected
		const w = frq.amp[i] > 0 ? frq.amp[i] : 1;
		num += hz * w;
		den += w;
	}
	return den > 0 ? num / den : 0;
}

/** Whole-file average f0 in Hz from a `.frq` file, or null. */
export function parseFrqAverageF0(buffer: ArrayBuffer): number | null {
	const frq = parseFrq(buffer);
	return frq && frq.averageF0 > 0 ? frq.averageF0 : null;
}

/** Map a WAV filename to its sibling frq filename: "あ.wav" → "あ_wav.frq". */
export function frqFileName(wavName: string): string {
	const dot = wavName.lastIndexOf(".");
	const base = dot >= 0 ? wavName.slice(0, dot) : wavName;
	const ext = dot >= 0 ? wavName.slice(dot + 1) : "wav";
	return `${base}_${ext}.frq`;
}
