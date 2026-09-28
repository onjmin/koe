import type { Manifest } from "../types.js";
import { frqAverageF0InRange, frqFileName, parseFrq } from "./frq.js";
import { otoRegion, type PackInput, pack } from "./pack.js";
import { fileKey, type OtoEntry, parseOto } from "./parse-oto.js";
import { pitchFromAliasSuffix } from "./pitch.js";
import { readWavPcm48k } from "./wav.js";

/** A file of the voice bank: anything that can hand over its bytes. */
export interface VoiceFile {
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ConvertOptions {
	/** Called once per oto entry, after it was converted or skipped. */
	onProgress?: (done: number, total: number) => void;
	/** Called for every entry that could not be converted. */
	onSkip?: (oto: OtoEntry, reason: string) => void;
}

export interface ConvertResult {
	manifest: Manifest;
	/** Raw PCM blob — Int16 / 48kHz / mono */
	bin: ArrayBuffer;
	/** oto.ini files found. */
	otoFiles: number;
	/** oto entries converted. */
	count: number;
	/** oto entries skipped (missing or unreadable WAV). */
	skipped: number;
}

/** Decode oto.ini: traditionally Shift-JIS, but honour a UTF-8 BOM. */
export function decodeOto(bytes: Uint8Array): string {
	const utf8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	return new TextDecoder(utf8 ? "utf-8" : "shift_jis").decode(bytes);
}

/**
 * Recorded pitch of one oto entry: the `.frq` curve averaged over the region
 * the phoneme actually uses — preferring the sustain (from the preutterance to
 * the cutoff), which carries the perceived pitch and is what two notes have to
 * agree on to crossfade coherently (the header's whole-file average drags in
 * leading silence and unvoiced consonants) — then the whole region, then the
 * header average. Without a `.frq`, the alias suffix; 0 lets `pack` fall back
 * to autocorrelation.
 */
function recordedPitchOf(
	oto: OtoEntry,
	pcmLength: number,
	sourceRate: number,
	frqBytes: ArrayBuffer | null,
): number {
	const suffix = pitchFromAliasSuffix(oto.alias) ?? 0;
	const frq = frqBytes ? parseFrq(frqBytes) : null;
	if (!frq) return suffix;
	const { start, end } = otoRegion(pcmLength, oto);
	const toMs = (samples: number) => (samples / 48000) * 1000;
	const local =
		frqAverageF0InRange(frq, toMs(start) + oto.pre, toMs(end), sourceRate) ||
		frqAverageF0InRange(frq, toMs(start), toMs(end), sourceRate) ||
		frq.averageF0;
	return local > 0 ? local : suffix;
}

/**
 * Convert a voice bank to a koe manifest + PCM blob. The one conversion path
 * shared by the CLI (files on disk) and the demo page (a zip or a picked
 * folder), so both produce the same `.koe` from the same bank.
 *
 * `files` maps each path inside the bank (forward slashes, any Unicode
 * normalisation) to its bytes. Paths are matched with {@link fileKey}, so
 * banks made on macOS — NFD file names (`か` + U+3099 for `が`) against an NFC
 * oto.ini — convert completely.
 */
export async function convertVoicebank(
	files: Iterable<[string, VoiceFile]>,
	options: ConvertOptions = {},
): Promise<ConvertResult> {
	const byKey = new Map<string, VoiceFile>();
	for (const [path, file] of files) byKey.set(fileKey(path), file);

	const otoPaths = [...byKey.keys()].filter((p) => /(^|\/)oto\.ini$/i.test(p));
	const entries: { oto: OtoEntry; dir: string }[] = [];
	for (const otoPath of otoPaths) {
		const dir = otoPath.slice(0, otoPath.lastIndexOf("/") + 1);
		const oto = byKey.get(otoPath);
		if (!oto) continue;
		const bytes = new Uint8Array(await oto.arrayBuffer());
		for (const entry of parseOto(decodeOto(bytes)))
			entries.push({ oto: entry, dir });
	}

	const inputs: PackInput[] = [];
	let skipped = 0;
	let done = 0;
	for (const { oto, dir } of entries) {
		try {
			const wavName = fileKey(oto.wav);
			// oto.ini may not point outside the bank (`wav=..\..\secret`).
			if (wavName.split("/").includes("..")) {
				throw new Error(`path escapes voice bank directory: ${oto.wav}`);
			}
			const wav = byKey.get(dir + wavName);
			if (!wav) throw new Error(`missing file: ${oto.wav}`);
			const { pcm, sourceRate } = readWavPcm48k(await wav.arrayBuffer());
			const frq = byKey.get(dir + frqFileName(wavName));
			const recordedPitch = recordedPitchOf(
				oto,
				pcm.length,
				sourceRate,
				frq ? await frq.arrayBuffer() : null,
			);
			inputs.push({ oto, pcm, recordedPitch });
		} catch (err) {
			skipped++;
			options.onSkip?.(oto, err instanceof Error ? err.message : String(err));
		}
		options.onProgress?.(++done, entries.length);
	}

	const { manifest, bin } = pack(inputs);
	return {
		manifest,
		bin,
		otoFiles: otoPaths.length,
		count: Object.keys(manifest.phonemes).length,
		skipped,
	};
}
