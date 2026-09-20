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
	estimateSequenceDetail,
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
	/**
	 * Emit one `a R` … `n R` release entry per vowel from the 連続音 files, so a
	 * note before a rest lets go the way the singer did. Default true.
	 */
	restAliases?: boolean;
	/**
	 * Copy every お entry to を when the list did not record を itself, so a
	 * UST that spells the particle を does not fall silent. Default true.
	 */
	woAliases?: boolean;
	/**
	 * Mora interval to fit a 連続音 file around, in ms. {@link generateOto} sets
	 * this itself for files whose own tempo estimate disagrees with the rest of
	 * the folder; a caller driving {@link generateOtoForFile} directly can pass
	 * the folder's tempo the same way.
	 */
	intervalHintMs?: number;
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
	/** Mora interval a 連続音 file was fitted at, in ms; 0 otherwise. */
	intervalMs: number;
	/** The filename carried an R/息 marker: a deliberate release take. */
	explicitRest: boolean;
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
	const prepared = prepareOtoFile(file);
	return "skipped" in prepared
		? prepared.skipped
		: estimateOtoFile(prepared, options);
}

/** A decoded, analysed recording, ready to be estimated (again, if need be). */
export interface PreparedFile {
	name: string;
	frames: Frames;
	transcript: Transcript;
}

/** What {@link prepareOtoFile} returns for a file that cannot be set up. */
export interface SkippedPrepared {
	skipped: FileResult;
}

/**
 * Decode and analyse one file. The analysis is the expensive half of the
 * work and does not depend on any option, so a folder pass keeps it and only
 * re-runs {@link estimateOtoFile} when a file has to be refitted.
 *
 * A caller that drives a folder itself — to yield to the UI between files —
 * goes prepare → estimate per file, then hands everything to
 * {@link finishOto}; that last step is where the folder-wide work lives
 * (tempo refit, one `a R` per vowel, `を` from `お`), and skipping it is what
 * a per-file loop over {@link generateOtoForFile} silently does.
 */
export function prepareOtoFile(file: WavInput): PreparedFile | SkippedPrepared {
	const skip = (reason: string): { skipped: FileResult } => ({
		skipped: {
			entries: [],
			skipped: { wav: file.name, reason },
			style: null,
			intervalMs: 0,
			explicitRest: false,
		},
	});

	const transcript = transcribe(file.name);
	if (!transcript) return skip("filename is not kana");

	let frames: Frames;
	try {
		frames = analyze(parseWav(file.data));
	} catch (err) {
		return skip(err instanceof Error ? err.message : String(err));
	}
	if (frames.n < 8) return skip("too short to analyse");
	return { name: file.name, frames, transcript };
}

/** Estimate one prepared file. See {@link prepareOtoFile}. */
export function estimateOtoFile(
	prepared: PreparedFile,
	options: GenerateOptions = {},
): FileResult {
	const suffix = options.suffix ?? "";
	const headAliases = options.headAliases ?? true;
	const vowelJoinAliases = options.vowelJoinAliases ?? true;
	const { frames, transcript } = prepared;
	const file = { name: prepared.name };
	const skip = (reason: string): FileResult => ({
		entries: [],
		skipped: { wav: file.name, reason },
		style: null,
		intervalMs: 0,
		explicitRest: false,
	});

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
		return {
			entries,
			skipped: null,
			style: "solo",
			intervalMs: 0,
			explicitRest: false,
		};
	}

	const { entries, intervalMs } = estimateSequenceDetail(
		file.name,
		frames,
		syllables,
		{
			suffix: `${mark}${suffix}`,
			prefix,
			trailingRest,
			restAlias: options.restAliases ?? true,
			intervalHintMs: options.intervalHintMs,
		},
	);
	if (entries.length === 0) return skip("could not segment the phrase");
	return {
		entries,
		skipped: null,
		style: "sequence",
		intervalMs,
		explicitRest: trailingRest,
	};
}

/**
 * A file's tempo this far from the folder's is a mis-fit, not a slow take.
 *
 * Lists are sung to a click, so a genuine take is within a few percent of the
 * folder. What lands outside is a file whose own onsets were too weak to fit:
 * a legato vowel list whose held final vowel stretched the span by half, or a
 * file of glides that autocorrelated at a fraction of the beat.
 */
const INTERVAL_OUTLIER_RATIO = 1.12;

/** Median of the positive values, or 0 when there are none. */
function medianInterval(values: readonly number[]): number {
	const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
	return sorted.length ? sorted[sorted.length >> 1] : 0;
}

const REST_ALIAS = /^[aiueon] R/;

/**
 * Keep one `a R` per vowel. Every 連続音 file yields one, and they are all the
 * same release; the take that was recorded *as* a release (`_ああR`) is the
 * best source, and failing that the one with the longest tail to fade over.
 */
function dedupeRestAliases(
	entries: OtoEntry[],
	explicitRestWavs: ReadonlySet<string>,
): OtoEntry[] {
	const tail = (e: OtoEntry): number => -e.cutoff - e.pre;
	const rank = (e: OtoEntry): number =>
		(explicitRestWavs.has(e.wav) ? 1e6 : 0) + tail(e);
	const best = new Map<string, OtoEntry>();
	for (const e of entries) {
		if (!REST_ALIAS.test(e.alias)) continue;
		const cur = best.get(e.alias);
		if (!cur || rank(e) > rank(cur)) best.set(e.alias, e);
	}
	return entries.filter(
		(e) => !REST_ALIAS.test(e.alias) || best.get(e.alias) === e,
	);
}

/** `a お_G4` → `a を_G4`; null when the alias is not a bare お. */
function woAliasOf(alias: string): string | null {
	const m = /^((?:- |\* |[aiueon] )?)お(?![ぁ-ぉゃゅょゎ])(.*)$/.exec(alias);
	return m ? `${m[1]}を${m[2]}` : null;
}

/**
 * Give を the sound of お wherever the list did not record it. Lyrics spell
 * the particle を, and a phonemizer that finds no `a を` drops the note.
 */
function addWoAliases(entries: OtoEntry[]): OtoEntry[] {
	const present = new Set(entries.map((e) => e.alias));
	const out: OtoEntry[] = [];
	for (const e of entries) {
		out.push(e);
		const wo = woAliasOf(e.alias);
		if (wo && !present.has(wo)) {
			present.add(wo);
			out.push({ ...e, alias: wo });
		}
	}
	return out;
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
	const prepared = files.map((file) => prepareOtoFile(file));
	const results = prepared.map((p) =>
		"skipped" in p ? p.skipped : estimateOtoFile(p, options),
	);
	return finishOto(prepared, results, options);
}

/**
 * Fold per-file results into the folder's oto.ini. `prepared[i]` and
 * `results[i]` describe the same file, in the order they were run.
 *
 * Three things only make sense with the whole folder in view: refitting the
 * files whose tempo disagrees with the rest, keeping one `a R` per vowel, and
 * copying お to を when を was never recorded.
 */
export function finishOto(
	prepared: readonly (PreparedFile | SkippedPrepared)[],
	results: readonly FileResult[],
	options: GenerateOptions = {},
): GenerateResult {
	if (prepared.length !== results.length) {
		throw new Error("finishOto: prepared and results must line up");
	}
	const refitted = [...results];

	// A 連続音 list is sung to one guide tempo, so the files agree on their mora
	// interval — except the few whose onsets are too weak to measure. Those get
	// refitted around the folder's tempo instead of a sub-multiple of it.
	if (options.intervalHintMs === undefined) {
		const folderMs = medianInterval(refitted.map((r) => r.intervalMs));
		if (folderMs > 0) {
			for (let i = 0; i < refitted.length; i++) {
				const r = refitted[i];
				const p = prepared[i];
				if (r.style !== "sequence" || "skipped" in p) continue;
				const ratio = r.intervalMs / folderMs;
				if (
					ratio < 1 / INTERVAL_OUTLIER_RATIO ||
					ratio > INTERVAL_OUTLIER_RATIO
				) {
					refitted[i] = estimateOtoFile(p, {
						...options,
						intervalHintMs: folderMs,
					});
				}
			}
		}
	}

	let entries: OtoEntry[] = [];
	const skipped: SkippedFile[] = [];
	const explicitRestWavs = new Set<string>();
	let solo = 0;
	let sequence = 0;

	for (let i = 0; i < refitted.length; i++) {
		const result = refitted[i];
		const p = prepared[i];
		entries.push(...result.entries);
		if (result.skipped) skipped.push(result.skipped);
		if (result.style === "solo") solo++;
		if (result.style === "sequence") sequence++;
		if (result.explicitRest && !("skipped" in p)) explicitRestWavs.add(p.name);
	}

	if (options.restAliases ?? true) {
		entries = dedupeRestAliases(entries, explicitRestWavs);
	}
	if (options.woAliases ?? true) entries = addWoAliases(entries);

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
