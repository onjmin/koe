import type { Manifest } from "../types.js";
import { parseKoeHeader, pcmBase } from "../koe.js";

/**
 * Supplies raw bytes from the PCM section of a .koe archive on demand.
 *  - BlobVoiceSource:  slices an in-memory Blob / File (no full-buffer copy)
 *  - RangeVoiceSource: HTTP Range requests against a URL (mobile-friendly)
 * `base` is the byte offset where PCM data starts (8 + jsonLength).
 */
interface VoiceSource {
	readBytes(offset: number, length: number): Promise<ArrayBuffer>;
}

/** Hard ceiling on a single phoneme's PCM size (~10.5 MB / ~55s at 48kHz). */
const MAX_PHONEME_SAMPLES = 5_242_880;
/** Hard ceiling on the manifest JSON header itself. */
const MAX_JSON_LENGTH = 50 * 1024 * 1024;

class BlobVoiceSource implements VoiceSource {
	constructor(
		private blob: Blob,
		private base: number,
	) {}
	readBytes(offset: number, length: number): Promise<ArrayBuffer> {
		const start = this.base + offset;
		return this.blob.slice(start, start + length).arrayBuffer();
	}
}

class RangeVoiceSource implements VoiceSource {
	constructor(
		private url: string,
		private base: number,
	) {}
	async readBytes(offset: number, length: number): Promise<ArrayBuffer> {
		const start = this.base + offset;
		return rangeFetch(this.url, start, length);
	}
}

async function rangeFetch(
	url: string,
	start: number,
	length: number,
): Promise<ArrayBuffer> {
	const res = await fetch(url, {
		headers: { Range: `bytes=${start}-${start + length - 1}` },
		credentials: "omit", // never leak cookies / auth to a MML-supplied URL
	});
	// A server that ignores Range and returns 200 with the full file would
	// blow past the requested size and exhaust memory; only accept 206.
	if (res.status !== 206) {
		throw new Error(
			`.koe fetch failed: expected 206 Partial Content, got ${res.status}`,
		);
	}
	return res.arrayBuffer();
}

function validateJsonLength(jsonLength: number): void {
	if (
		!Number.isInteger(jsonLength) ||
		jsonLength < 0 ||
		jsonLength > MAX_JSON_LENGTH
	) {
		throw new Error(`manifest JSON length out of bounds: ${jsonLength}`);
	}
}

function parseManifest(json: ArrayBuffer): Manifest {
	const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
	if (
		!manifest ||
		typeof manifest !== "object" ||
		typeof manifest.phonemes !== "object" ||
		manifest.phonemes === null
	) {
		throw new Error("invalid manifest: missing phonemes table");
	}
	return manifest;
}

/**
 * Read-only access to a .koe voice bank: its manifest plus per-phoneme PCM,
 * fetched on demand (Blob slice or HTTP Range). The full bank is never held in
 * memory.
 *
 * Pure data — no AudioContext, no AudioWorklet, no DOM. Use this when you only
 * need the source samples (e.g. to feed the {@link Worldline} renderer or any
 * other vocoder). {@link KoeEngine} builds its concatenative playback on top of
 * this same class.
 *
 *   const bank = await VoiceBank.load(koeBlobOrUrl);
 *   const pcm  = await bank.getPcm('a');   // Float64 [-1, 1]
 */
export class VoiceBank {
	private constructor(
		/** The voice bank manifest (sample rate, reference pitch, phoneme table). */
		readonly manifest: Manifest,
		private source: VoiceSource,
	) {}

	/**
	 * Parse a .koe archive header + manifest and bind a lazy PCM source.
	 * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
	 */
	static async load(koe: Blob | string): Promise<VoiceBank> {
		try {
			if (typeof koe === "string") {
				if (!/^(https?|blob):/i.test(koe)) {
					throw new Error(`unsupported URL protocol: ${koe}`);
				}
				const header = await rangeFetch(koe, 0, 8);
				const { jsonLength } = parseKoeHeader(header);
				validateJsonLength(jsonLength);
				const json = await rangeFetch(koe, 8, jsonLength);
				const manifest = parseManifest(json);
				return new VoiceBank(
					manifest,
					new RangeVoiceSource(koe, pcmBase(jsonLength)),
				);
			}
			const header = await koe.slice(0, 8).arrayBuffer();
			const { jsonLength } = parseKoeHeader(header);
			validateJsonLength(jsonLength);
			const json = await koe.slice(8, 8 + jsonLength).arrayBuffer();
			const manifest = parseManifest(json);
			return new VoiceBank(
				manifest,
				new BlobVoiceSource(koe, pcmBase(jsonLength)),
			);
		} catch (error) {
			throw new Error(
				`Failed to load .koe voice bank: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** True if the bank contains a phoneme under this alias. */
	has(phoneme: string): boolean {
		return this.manifest.phonemes[phoneme] !== undefined;
	}

	/**
	 * Raw Int16 PCM bytes (48 kHz / mono) for a phoneme, or null if unknown.
	 * The returned ArrayBuffer is freshly allocated and safe to transfer to a
	 * worker / AudioWorklet.
	 */
	async readPcmBytes(phoneme: string): Promise<ArrayBuffer | null> {
		const entry = this.manifest.phonemes[phoneme];
		if (!entry) return null;
		if (
			!Number.isInteger(entry.offset) ||
			!Number.isInteger(entry.length) ||
			entry.offset < 0 ||
			entry.length < 0 ||
			entry.length > MAX_PHONEME_SAMPLES
		) {
			throw new Error(`manifest entry out of bounds for phoneme: ${phoneme}`);
		}
		return this.source.readBytes(entry.offset, entry.length * 2); // Int16 = 2 bytes/sample
	}

	/**
	 * A phoneme's PCM as a Float64Array normalised to [-1, 1], or null if unknown.
	 * Intended for external analysis / resynthesis such as the WORLD vocoder.
	 */
	async getPcm(phoneme: string): Promise<Float64Array | null> {
		const buf = await this.readPcmBytes(phoneme);
		if (!buf) return null;
		const int16 = new Int16Array(buf);
		const f64 = new Float64Array(int16.length);
		for (let i = 0; i < int16.length; i++) f64[i] = int16[i] / 32768;
		return f64;
	}
}
