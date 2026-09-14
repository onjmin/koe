/**
 * Folder → oto.ini, with no manual step in between.
 *
 * The filename carries the transcript, so the recording style falls out of it:
 * one mora per file is 単独音, several is 連続音. Everything else — which
 * aliases to emit, where the phrase head goes, whether a trailing R belongs on
 * the end — follows from the same parse.
 */

import type { OtoEntry } from "../converter/parse-oto.js";
import { parseWav } from "../converter/wav.js";
import {
	estimateSequence,
	estimateSolo,
	estimateVowelJoin,
} from "./estimate.js";
import { analyze, type Frames } from "./frames.js";
import { type Syllable, splitKana, toHiragana } from "./kana.js";

export interface GenerateOptions {
	/**
	 * Appended to every alias — the usual home for a multi-pitch or expression
	 * marker (`_G4`, `強`). Defaults to the folder's own note name when it has
	 * one; pass `""` to suppress that.
	 */
	suffix?: string;
	/** Emit `- か` phrase-head aliases alongside the bare kana. Default true. */
	headAliases?: boolean;
	/** Emit `* あ` 母音結合 aliases for vowel-only files. Default true. */
	vowelJoinAliases?: boolean;
}

/** One file that could not be transcribed, and why. */
export interface SkippedFile {
	wav: string;
	reason: string;
}

export interface GenerateResult {
	entries: OtoEntry[];
	skipped: SkippedFile[];
	/** Recording style inferred from the filenames. */
	style: "solo" | "sequence" | "mixed" | "empty";
}

/** What one recording produced. */
export interface FileResult {
	entries: OtoEntry[];
	/** Set instead of entries when the file could not be set up. */
	skipped: SkippedFile | null;
	/** Style this one file was read as, or null if it was skipped. */
	style: "solo" | "sequence" | null;
}

export interface WavInput {
	/** Filename as it appears in oto.ini, e.g. `_ああいあう.wav`. */
	name: string;
	data: ArrayBuffer;
}

/** A rest/breath marker that ends a 連続音 phrase. */
const REST = /[RrＲｒ]$|息$|吸$/;

interface Transcript {
	syllables: Syllable[];
	trailingRest: boolean;
	/** Non-kana marker before the kana, e.g. the `x` of `_xか.wav`. */
	prefix: string;
	/** Non-kana marker after the kana, e.g. the `b` of `_あb.wav`. */
	mark: string;
}

/**
 * Read the transcript out of a filename.
 *
 * The leading `_` that marks a recording-list file, an extension, and a
 * trailing pitch tag are all noise; what is left has to be kana end to end, or
 * the file is not a voice sample we can set up (a karaoke track, a sample song,
 * a readme recording).
 */
export function transcribe(filename: string): Transcript | null {
	let body = filename.replace(/\.[^.]+$/, "");
	body = body.replace(/^[_\-\s]+/, "");
	// Drop a per-file pitch tag such as `_C4` / `_A#3`.
	body = body.replace(/_[A-G][#b]?-?\d$/i, "");
	body = body.trim();
	if (!body) return null;

	// Take markers ride along into the alias rather than being discarded: a bank
	// that recorded `_あb.wav` as a second take means its oto.ini to say `あb`,
	// and `_ううわうぉわ↑.wav` is a distinct entry from the unmarked one.
	let mark = "";
	const arrows = /[↑↓→]+$/.exec(body);
	if (arrows) {
		mark = arrows[0];
		body = body.slice(0, -arrows[0].length);
	}

	let trailingRest = false;
	if (REST.test(body)) {
		trailingRest = true;
		body = body.replace(REST, "");
	}

	const take = /[A-Za-z0-9'][A-Za-z0-9']?$/.exec(body);
	if (take && body.length > take[0].length) {
		mark = take[0] + mark;
		body = body.slice(0, -take[0].length);
	}

	// A leading ASCII marker only counts when kana follows it — `_xか.wav` is a
	// devoiced か, while `1646312012.wav` is not a recording at all.
	let prefix = "";
	const head = /^[A-Za-z]{1,2}(?=[ぁ-ゟァ-ヿ])/.exec(body);
	if (head) {
		prefix = head[0];
		body = body.slice(head[0].length);
	}
	if (!body) return null;

	const syllables = splitKana(body);
	if (!syllables) return null;
	return { syllables, trailingRest, prefix, mark };
}

/**
 * Alias suffix implied by a folder's name.
 *
 * A multi-pitch bank keeps one folder per pitch and merges every oto.ini into
 * one alias namespace, so without the pitch tag each folder's `- あ` would
 * overwrite the last. The tag is taken either from a folder named for nothing
 * but the pitch (`G4`) or from an explicit `_G4` token inside a longer name
 * (`多音階03：_G4（連続音）`). A bare `G4` buried in a name is left alone — in
 * `表情音01：強（G4歌連続音）` it describes the take, and the suffix the bank
 * actually uses there is `強`, which no filename carries.
 */
export function suffixFromFolderName(folder: string): string {
	if (/^[A-G][#b]?-?\d$/.test(folder)) return `_${folder}`;
	const tagged = /_([A-G][#b]?-?\d)(?![0-9A-Za-z])/.exec(folder);
	return tagged ? `_${tagged[1]}` : "";
}

function aliasesFor(name: string, headAliases: boolean): string[] {
	return headAliases ? [name, `- ${name}`] : [name];
}

/**
 * Estimate oto.ini entries for every WAV in one folder.
 *
 * Decoding and analysis are per-file and independent, so a bad WAV is reported
 * and skipped rather than failing the folder.
 */
export function generateOtoForFile(
	file: WavInput,
	options: GenerateOptions = {},
): FileResult {
	const suffix = options.suffix ?? "";
	const headAliases = options.headAliases ?? true;
	const vowelJoinAliases = options.vowelJoinAliases ?? true;

	const transcript = transcribe(file.name);
	if (!transcript) {
		return {
			entries: [],
			skipped: { wav: file.name, reason: "filename is not kana" },
			style: null,
		};
	}

	let frames: Frames;
	try {
		frames = analyze(parseWav(file.data));
	} catch (err) {
		return {
			entries: [],
			skipped: {
				wav: file.name,
				reason: err instanceof Error ? err.message : String(err),
			},
			style: null,
		};
	}
	if (frames.n < 8) {
		return {
			entries: [],
			skipped: { wav: file.name, reason: "too short to analyse" },
			style: null,
		};
	}

	const { syllables, trailingRest, prefix, mark } = transcript;

	if (syllables.length === 1 && !trailingRest) {
		const syl = syllables[0];
		const name = `${prefix}${syl.kana}${mark}${suffix}`;
		const entries = estimateSolo(
			file.name,
			frames,
			syl,
			aliasesFor(name, headAliases),
		);

		// あ/い/う/え/お/ん also get a 母音結合 entry, cut from the steady part of
		// the same note — the `* あ` aliases a 連続音-style phrase leans on.
		if (vowelJoinAliases && (syl.cls === "vowel" || syl.cls === "nasalN")) {
			const join = estimateVowelJoin(file.name, frames, syl, `* ${name}`);
			if (join) entries.push(join);
		}
		return { entries, skipped: null, style: "solo" };
	}

	const entries = estimateSequence(file.name, frames, syllables, {
		suffix: `${mark}${suffix}`,
		prefix,
		trailingRest,
	});
	if (entries.length === 0) {
		return {
			entries: [],
			skipped: { wav: file.name, reason: "could not segment the phrase" },
			style: null,
		};
	}
	return { entries, skipped: null, style: "sequence" };
}

/**
 * Estimate oto.ini entries for every WAV in one folder.
 *
 * Decoding and analysis are per-file and independent, so a bad WAV is reported
 * and skipped rather than failing the folder. A caller that needs to stay
 * responsive — a browser UI, say — should drive {@link generateOtoForFile}
 * itself and yield between files.
 */
export function generateOto(
	files: readonly WavInput[],
	options: GenerateOptions = {},
): GenerateResult {
	const entries: OtoEntry[] = [];
	const skipped: SkippedFile[] = [];
	let solo = 0;
	let sequence = 0;

	for (const file of files) {
		const result = generateOtoForFile(file, options);
		entries.push(...result.entries);
		if (result.skipped) skipped.push(result.skipped);
		if (result.style === "solo") solo++;
		if (result.style === "sequence") sequence++;
	}

	return { entries, skipped, style: summarise(solo, sequence) };
}

/** Fold per-file styles into the one label that describes the folder. */
export function summarise(
	solo: number,
	sequence: number,
): GenerateResult["style"] {
	if (solo && sequence) return "mixed";
	if (sequence) return "sequence";
	if (solo) return "solo";
	return "empty";
}

/** Exposed for callers that want to pre-flight a folder without decoding audio. */
export function looksLikeVoiceFolder(names: readonly string[]): boolean {
	return names.some(
		(n) => /\.wav$/i.test(n) && transcribe(n) !== null && toHiragana(n) !== "",
	);
}
