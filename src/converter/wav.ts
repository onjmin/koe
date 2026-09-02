export interface WavData {
	sampleRate: number;
	channels: number;
	/** Normalized samples in [-1, 1], interleaved if multi-channel */
	samples: Float32Array;
}

/** Parse a WAV file from an ArrayBuffer. Supports PCM 8/16/24-bit and IEEE float 32-bit. */
export function parseWav(buf: ArrayBuffer): WavData {
	const view = new DataView(buf);

	const riff = readFourCC(view, 0);
	if (riff !== "RIFF") throw new Error(`Not a RIFF file (got "${riff}")`);

	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let audioFormat = 1;
	let dataOffset = 0;
	let dataLength = 0;

	let pos = 12;
	while (pos < view.byteLength - 8) {
		const id = readFourCC(view, pos);
		const size = view.getUint32(pos + 4, true);
		pos += 8;

		if (id === "fmt ") {
			audioFormat = view.getUint16(pos, true);
			channels = view.getUint16(pos + 2, true);
			sampleRate = view.getUint32(pos + 4, true);
			bitsPerSample = view.getUint16(pos + 14, true);
			// WAVE_FORMAT_EXTENSIBLE: the real format code is the first 2 bytes of
			// the SubFormat GUID in the extension.
			if (audioFormat === 0xfffe && size >= 40) {
				audioFormat = view.getUint16(pos + 24, true);
			}
		} else if (id === "data") {
			dataOffset = pos;
			// Clamp to the actual file size — a corrupt chunk header could otherwise
			// send sample reads past the end of the buffer.
			dataLength = Math.min(size, view.byteLength - pos);
			break;
		}

		pos += size + (size & 1);
	}

	if (!dataOffset) throw new Error("WAV has no data chunk");
	if (!channels || !sampleRate) throw new Error("WAV fmt chunk missing");

	// Reject anything the sample loop below cannot decode — falling through
	// would silently produce all-zero (silent) audio.
	const supported =
		(audioFormat === 3 && bitsPerSample === 32) ||
		(audioFormat === 1 &&
			(bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24));
	if (!supported) {
		throw new Error(
			`Unsupported WAV format ${audioFormat} / ${bitsPerSample}-bit (need PCM 8/16/24-bit or IEEE float 32-bit)`,
		);
	}

	const bytesPerSample = bitsPerSample >> 3;
	const totalSamples = Math.floor(dataLength / bytesPerSample);
	const samples = new Float32Array(totalSamples);

	for (let i = 0; i < totalSamples; i++) {
		const p = dataOffset + i * bytesPerSample;
		if (audioFormat === 3) {
			samples[i] = view.getFloat32(p, true);
		} else if (bitsPerSample === 8) {
			samples[i] = (view.getUint8(p) - 128) / 128;
		} else if (bitsPerSample === 16) {
			samples[i] = view.getInt16(p, true) / 32768;
		} else if (bitsPerSample === 24) {
			const lo = view.getUint8(p) | (view.getUint8(p + 1) << 8);
			let hi = view.getUint8(p + 2);
			if (hi & 0x80) hi = hi | 0xffffff00;
			samples[i] = ((hi << 16) | lo) / 8388608;
		}
	}

	return { sampleRate, channels, samples };
}

/** Mix down to mono by averaging all channels. */
export function toMono(wav: WavData): WavData {
	if (wav.channels === 1) return wav;
	const len = wav.samples.length / wav.channels;
	const out = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		let sum = 0;
		for (let c = 0; c < wav.channels; c++)
			sum += wav.samples[i * wav.channels + c];
		out[i] = sum / wav.channels;
	}
	return { sampleRate: wav.sampleRate, channels: 1, samples: out };
}

/** Linear interpolation resample to targetRate. Expects mono input. */
export function resample(wav: WavData, targetRate: number): WavData {
	if (wav.sampleRate === targetRate) return wav;
	const ratio = wav.sampleRate / targetRate;
	const outLen = Math.floor(wav.samples.length / ratio);
	const out = new Float32Array(outLen);
	const src = wav.samples;
	for (let i = 0; i < outLen; i++) {
		const x = i * ratio;
		const xi = Math.floor(x);
		const frac = x - xi;
		out[i] = (src[xi] ?? 0) + ((src[xi + 1] ?? 0) - (src[xi] ?? 0)) * frac;
	}
	return { sampleRate: targetRate, channels: 1, samples: out };
}

/** Convert Float32 [-1,1] samples to Int16 PCM. */
export function toInt16(samples: Float32Array): Int16Array {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
	}
	return out;
}

/**
 * Decode a WAV to 48kHz/16bit/mono Int16 PCM, reporting the source sample rate.
 *
 * The rate is needed to index a sibling `.frq` file, whose analysis hop is
 * counted in ORIGINAL samples — see {@link frqAverageF0InRange}.
 *
 * Note this does not touch amplitude: peak levels are carried through
 * unchanged, so a bank's own relative loudness between phonemes is preserved
 * (UTAU's engine instead normalises each region to −6 dBFS, which is why its
 * イ/エ段 and 語尾 samples come out louder than recorded).
 */
export function readWavPcm48k(buf: ArrayBuffer): {
	pcm: Int16Array;
	sourceRate: number;
} {
	const wav = parseWav(buf);
	const mono = toMono(wav);
	const resampled = resample(mono, 48000);
	return { pcm: toInt16(resampled.samples), sourceRate: wav.sampleRate };
}

/**
 * Convert a WAV to 48kHz/16bit/mono Int16 PCM.
 *
 * @deprecated Misnomer — this never normalised amplitude. Use
 * {@link readWavPcm48k}, which also reports the source sample rate.
 */
export function normalizePcm(buf: ArrayBuffer): Int16Array {
	return readWavPcm48k(buf).pcm;
}

function readFourCC(view: DataView, pos: number): string {
	return String.fromCharCode(
		view.getUint8(pos),
		view.getUint8(pos + 1),
		view.getUint8(pos + 2),
		view.getUint8(pos + 3),
	);
}
