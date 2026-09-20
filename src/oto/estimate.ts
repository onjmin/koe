/**
 * Parameter estimation for oto.ini entries.
 *
 * The rules encoded here follow the UTAU音源制作wiki's 原音設定 articles
 * (https://w.atwiki.jp/vbmaker/pages/17.html and its 単独音 / 連続音 sequels):
 *
 * - オフセット sits just before the consonant, keeping a little room so the
 *   attack is never clipped.
 * - 先行発声 marks where the *vowel* begins — the voicing onset for a voiceless
 *   consonant, the release for a nasal or a flap, the midpoint of the glide for
 *   や/わ行.
 * - 子音部 runs from the offset through the vowel's onset until the spectrum
 *   settles, so a long note stretches only steady-state vowel.
 * - オーバーラップ is ~20 ms for さ/な/ま/ら行, ~30 ms for や/わ行, and goes
 *   *negative* for 破裂音 to reproduce the silent closure of か/た/ぱ行.
 * - 右ブランク lands just before the note starts to decay.
 */

import type { OtoEntry } from "../converter/parse-oto.js";
import {
	type Frames,
	framesToMs,
	frameTimeMs,
	HOP_MS,
	msToFrame,
	smooth,
} from "./frames.js";
import type { ConsonantClass, Syllable } from "./kana.js";

/** Per-class settings derived from the wiki's 原音設定解説. */
interface Articulation {
	/**
	 * Longest consonant kept ahead of the vowel. The wiki warns that a 先行発声
	 * past ~100 ms reads as a staccato "溜め"; sibilants are the exception, and
	 * routinely run longer in hand-tuned banks.
	 */
	maxConsonantMs: number;
	/** Silence kept before the consonant so the attack is not clipped. */
	leadInMs: number;
	/**
	 * オーバーラップ as a fraction of the preutterance.
	 *
	 * The wiki gives absolutes — 20 ms for さ/な/ま/ら行, 30 ms for や/わ行,
	 * "下限は15ミリ秒、上限は先行発声と同じ値くらい" — but a fraction expresses the
	 * same rule while scaling with how long the consonant actually came out. The
	 * ratios below are what the reference banks work out to: roughly 0.6 of the
	 * preutterance for sonorants, 0.3 for the obstruents whose noise should not
	 * bleed into the previous note.
	 */
	overlapRatio: number;
	/** Overrides {@link overlapRatio} when the class wants a fixed value. */
	fixedOverlapMs?: number;
	/** True when the vocal folds are already running during the consonant. */
	voicedConsonant: boolean;
	/** True when the consonant is noise, and so begins in the >4 kHz band. */
	fricationOnset: boolean;
}

const ARTICULATION: Record<ConsonantClass, Articulation> = {
	vowel: {
		maxConsonantMs: 40,
		leadInMs: 3,
		overlapRatio: 0,
		fixedOverlapMs: 20,
		voicedConsonant: true,
		fricationOnset: false,
	},
	nasalN: {
		maxConsonantMs: 40,
		leadInMs: 3,
		overlapRatio: 0,
		fixedOverlapMs: 20,
		voicedConsonant: true,
		fricationOnset: false,
	},
	nasal: {
		maxConsonantMs: 110,
		leadInMs: 5,
		overlapRatio: 0.6,
		voicedConsonant: true,
		fricationOnset: false,
	},
	liquid: {
		maxConsonantMs: 80,
		leadInMs: 5,
		overlapRatio: 0.6,
		voicedConsonant: true,
		fricationOnset: false,
	},
	semivowel: {
		maxConsonantMs: 75,
		leadInMs: 5,
		overlapRatio: 0.6,
		voicedConsonant: true,
		fricationOnset: false,
	},
	fricativeVoiceless: {
		maxConsonantMs: 140,
		leadInMs: 5,
		overlapRatio: 0.3,
		voicedConsonant: false,
		fricationOnset: true,
	},
	fricativeVoiced: {
		maxConsonantMs: 130,
		leadInMs: 5,
		overlapRatio: 0.4,
		voicedConsonant: true,
		fricationOnset: true,
	},
	affricate: {
		maxConsonantMs: 120,
		leadInMs: 5,
		overlapRatio: 0.3,
		voicedConsonant: false,
		fricationOnset: true,
	},
	plosiveVoiceless: {
		maxConsonantMs: 90,
		leadInMs: 8,
		overlapRatio: 0,
		// か/た/ぱ行 need a gap, not a crossfade: the wiki asks for a negative
		// overlap so the closure that precedes the burst survives synthesis.
		fixedOverlapMs: -10,
		voicedConsonant: false,
		fricationOnset: false,
	},
	plosiveVoiced: {
		maxConsonantMs: 90,
		leadInMs: 8,
		overlapRatio: 0.55,
		voicedConsonant: true,
		fricationOnset: false,
	},
};

/** Overlap never goes below this, nor above the preutterance. */
const MIN_OVERLAP_MS = 12;
const MAX_OVERLAP_MS = 40;

/** Periodicity above which a frame counts as voiced. */
const VOICED_THRESHOLD = 0.55;
/** A voiced run shorter than this is a glitch, not the start of a vowel. */
const VOICED_RUN_MS = 24;
/** な/ま/ら行 always hold their consonant at least this long before releasing. */
const MIN_VOICED_CONSONANT_MS = 22;
/**
 * Frames added to a within-phrase onset before it is taken as the vowel start.
 *
 * The onset track peaks while the transition is still happening; the note
 * belongs where the new vowel has arrived, which the reference banks put
 * consistently later.
 */
const SEQUENCE_ONSET_BIAS = 12; // 24 ms

/** Ceiling on a 連続音 entry's 先行発声, in milliseconds. */
const MAX_SEQUENCE_PRE_MS = 250;
/** dB below the note's peak at which it counts as having started to decay. */
const DECAY_DROP_DB = 4;
/** Margin left between the end of the usable region and the note's release. */
const RELEASE_GUARD_FRAMES = 10; // 20 ms

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/** How far above the noise floor a frame has to sit to count as sound. */
const SOUND_OVER_FLOOR_DB = 8;
/** Ceiling on that threshold, relative to the loudest frame. */
const SOUND_UNDER_PEAK_DB = 15;
/** dB the level must still be dropping over 6 ms for the attack to continue. */
const ATTACK_SLOPE_DB = 1;
/** Share of energy above 4 kHz that marks a frame as frication. */
const FRICATION_HIGH_RATIO = 0.45;
/**
 * Frication has to sit within this much of the loudest frame to count.
 *
 * Not a distance above the noise floor: on a recording cropped so tightly that
 * the /s/ *is* the quietest thing in the file, there is no floor to measure
 * against, and the loudest frame is the only stable reference.
 */
const FRICATION_UNDER_PEAK_DB = 30;

/** Level above which a frame is "sound" rather than room tone. */
function soundThreshold(f: Frames): number {
	return Math.min(
		Math.max(f.floorDb + SOUND_OVER_FLOOR_DB, f.peakDb - 34),
		f.peakDb - SOUND_UNDER_PEAK_DB,
	);
}

/** First frame in [from, to) whose smoothed level clears the sound threshold. */
export function findSoundStart(f: Frames, from: number, to: number): number {
	const th = soundThreshold(f);
	for (let t = Math.max(0, from); t < Math.min(f.n, to); t++) {
		if (f.smoothDb[t] >= th) return t;
	}
	return Math.max(0, from);
}

/** Last frame in (from, to] still above the sound threshold. */
export function findSoundEnd(f: Frames, from: number, to: number): number {
	const th = soundThreshold(f);
	for (let t = Math.min(f.n, to) - 1; t > from; t--) {
		if (f.smoothDb[t] >= th) return t;
	}
	return Math.min(f.n - 1, to);
}

/**
 * Where the consonant itself begins.
 *
 * Broadband level finds most attacks, but /s/ and /sh/ start as quiet hiss that
 * barely moves the meter while dominating the band above 4 kHz. Watching that
 * band as well is what stops さ行 from being set up as if the vowel's own
 * aspiration were the consonant.
 */
export function findConsonantStart(
	f: Frames,
	from: number,
	to: number,
	frication: boolean,
	maxBackMs = 150,
): number {
	const lo = Math.max(0, from);
	let start = findSoundStart(f, from, to);
	const soundStart = start;
	const earliest = Math.max(lo, soundStart - msToFrame(maxBackMs));

	if (frication) {
		// /s/ and /sh/ can be 20 dB down on the vowel and still be unmistakable,
		// because almost all of what little energy they have sits above 4 kHz.
		// A ratio test catches that where an absolute level never would — and on
		// a tightly cropped recording there is no quiet high band to compare to.
		//
		// The hiss is scanned *backwards* from the sound start, and only as far
		// as it stays continuous: the consonant runs straight into its vowel,
		// whereas a breath or a lip smack in the lead-in is separated from it by
		// room tone. Scanning forward from the start of the file would take the
		// first such noise as the consonant.
		const level = f.peakDb - FRICATION_UNDER_PEAK_DB;
		const absolute = leadInFloor(f.highDb, lo, soundStart, f.highFloorDb) + 8;
		const maxGap = msToFrame(16);
		let gap = 0;
		let t = start;
		while (t > earliest) {
			const byRatio =
				f.highRatio[t - 1] >= FRICATION_HIGH_RATIO &&
				f.smoothDb[t - 1] >= level;
			if (byRatio || f.highDb[t - 1] >= absolute) {
				gap = 0;
				start = t - 1;
			} else if (++gap > maxGap) {
				break;
			}
			t--;
		}
	}

	// The threshold above says "this is clearly the mora"; the attack itself
	// begins earlier. Walk back while the level is still falling — /h/ and /f/
	// ramp in over tens of milliseconds without ever being loud or sibilant, and
	// a ramp is the one thing that distinguishes them from room tone, which is
	// flat. Stop where the curve levels off, or where it reaches the floor.
	//
	// The floor is measured from the silence that actually precedes this attack,
	// not from the quietest window in the file: recorders fade the first few tens
	// of milliseconds in from digital zero, and a floor taken there sits so far
	// below the room tone that nothing ever reaches it — the walk then runs
	// through the whole lead-in, breath and all, to the start of the file. The
	// walk is capped as well, since no onset ramps in for longer than the
	// consonant it belongs to.
	const foot = leadInFloor(f.smoothDb, lo, soundStart, f.quietDb) + 6;
	const k = Math.max(1, msToFrame(6));
	while (start > earliest) {
		const back = Math.max(lo, start - k);
		const stillFalling =
			f.smoothDb[start] - f.smoothDb[back] >= ATTACK_SLOPE_DB;
		if (!stillFalling || f.smoothDb[start - 1] <= foot) break;
		start--;
	}
	return start;
}

/**
 * Level of the room tone directly ahead of an attack: the median of `track`
 * over `[from, to)`. Falls back to `fallback` (the file-wide quiet floor) when
 * there is not enough lead-in to measure — a tightly cropped 単独音, say.
 */
function leadInFloor(
	track: Float32Array,
	from: number,
	to: number,
	fallback: number,
): number {
	const need = msToFrame(60);
	if (to - from < need) return fallback;
	const sorted = Float32Array.from(track.subarray(from, to)).sort();
	return sorted[sorted.length >> 1];
}

/**
 * First frame of a sustained voiced run in [from, to). This is the vowel onset
 * for か/さ/た/は/ぱ行, whose consonants carry no voicing of their own.
 */
export function findVoiceOnset(f: Frames, from: number, to: number): number {
	const need = Math.ceil(VOICED_RUN_MS / HOP_MS);
	const hi = Math.min(f.n, to);
	// A vowel is never quiet. The breath of /h/ and the murmur of a voiced
	// fricative can flicker periodic for a few frames 40 dB below the note, and
	// without a level gate that flicker would be taken as the vowel.
	const th = soundThreshold(f);
	for (let t = Math.max(0, from); t < hi; t++) {
		if (f.voiced[t] < VOICED_THRESHOLD || f.smoothDb[t] < th) continue;
		let run = 0;
		while (t + run < hi && f.voiced[t + run] >= VOICED_THRESHOLD) run++;
		if (run >= need) return t;
		t += run;
	}
	return -1;
}

/**
 * How far ahead of the audible vowel the periodicity track reports voicing.
 *
 * The pitch window is 64 ms against the 32 ms FFT window and is not centred
 * on the same instant, so it crosses {@link VOICED_THRESHOLD} while only its
 * later half is in the vowel: measured on 響化アル, the first voiced frame sits
 * 16–20 ms before the vowel is there. Every 先行発声 that hangs off a voicing
 * onset — か・さ・た・は・ぱ行 and bare vowels — moves by this. The voiced
 * classes locate their release from the same track and were tuned on it as it
 * is, so they are left alone.
 */
const VOICING_LEAD_MS = 16;

/**
 * {@link findVoiceOnset}, shifted to where the vowel is actually heard. Use
 * this wherever the result *is* the 先行発声 rather than a search anchor.
 */
function findVowelOnset(f: Frames, from: number, to: number): number {
	const t = findVoiceOnset(f, from, to);
	return t >= 0 ? Math.min(Math.max(0, to - 1), t + msToFrame(VOICING_LEAD_MS)) : -1;
}

/**
 * Where a *voiced* consonant hands over to its vowel.
 *
 * な/ま行 release into the vowel with a step up in level; ら行 flaps do the
 * same over a few milliseconds; ざ行 lose their high-frequency noise; や/わ行
 * glide, and the wiki asks for the midpoint of that glide. All four show up as
 * a peak in the same combined measure — a local rise in level plus spectral
 * change — so one search covers them.
 */
function findVoicedRelease(f: Frames, from: number, to: number): number {
	const lo = Math.max(1, from);
	const hi = Math.min(f.n - 1, to);
	if (hi <= lo) return lo;

	const k = Math.max(1, msToFrame(10));
	let best = lo;
	let bestScore = -Infinity;
	for (let t = lo; t < hi; t++) {
		const rise =
			f.smoothDb[Math.min(f.n - 1, t + k)] - f.smoothDb[Math.max(0, t - k)];
		// Losing sibilance is as much a vowel onset as gaining loudness: ざ行 and
		// じゃ行 arrive by shedding their noise band, not by getting louder.
		const deSibilance =
			(f.highRatio[Math.max(0, t - k)] -
				f.highRatio[Math.min(f.n - 1, t + k)]) *
			30;
		const score = rise + deSibilance + f.flux[t];
		if (score > bestScore) {
			bestScore = score;
			best = t;
		}
	}
	return best;
}

/**
 * End of the transition into the vowel: the point past which the spectrum
 * stops moving, which is where 子音部/固定範囲 may stop.
 */
function findVowelStable(f: Frames, vowelOnset: number, limit: number): number {
	const minMs = 45;
	const maxMs = 110;
	const from = vowelOnset + msToFrame(minMs);
	const to = Math.min(limit, vowelOnset + msToFrame(maxMs));
	if (to <= from) return Math.min(limit, vowelOnset + msToFrame(minMs));

	const calm = smooth(f.flux, Math.max(1, msToFrame(12)));
	const need = Math.ceil(20 / HOP_MS);
	for (let t = from; t < to - need; t++) {
		let steady = true;
		for (let k = 0; k < need; k++) {
			if (calm[t + k] > 1.05) {
				steady = false;
				break;
			}
		}
		if (steady) return t;
	}
	return to;
}

/**
 * Where the note starts to fall away. Walking forward from the loudest frame
 * keeps a slow vibrato dip from being mistaken for the release.
 */
function findDecayStart(f: Frames, from: number, soundEnd: number): number {
	let peak = from;
	for (let t = from; t <= soundEnd; t++) {
		if (f.smoothDb[t] > f.smoothDb[peak]) peak = t;
	}
	// A shallow threshold on purpose: hand-set banks stop the 右ブランク while the
	// note is still strong, well before the tail has run out.
	const th = f.smoothDb[peak] - DECAY_DROP_DB;
	const need = Math.ceil(24 / HOP_MS);
	for (let t = peak; t <= soundEnd - need; t++) {
		let falling = true;
		for (let k = 0; k < need; k++) {
			if (f.smoothDb[t + k] >= th) {
				falling = false;
				break;
			}
		}
		// Back off a little further: 右ブランク should stop *before* the decay, so
		// nothing inside the stretched region is already fading.
		if (falling) return Math.max(from, t - RELEASE_GUARD_FRAMES);
	}
	// No clear release in range — the note runs to the end of what we can hear,
	// so keep the same margin off that instead.
	return Math.max(from, soundEnd - RELEASE_GUARD_FRAMES);
}

/** True when a が/だ/ば行 mora prevoices — a low "ん"-like hum before the burst. */
function hasPrevoicing(
	f: Frames,
	consStart: number,
	vowelOnset: number,
): boolean {
	if (vowelOnset - consStart < msToFrame(25)) return false;
	let voicedFrames = 0;
	for (let t = consStart; t < vowelOnset; t++) {
		if (f.voiced[t] >= VOICED_THRESHOLD) voicedFrames++;
	}
	return voicedFrames >= (vowelOnset - consStart) * 0.6;
}

/** Frame positions the oto parameters are built from. */
export interface MoraPosition {
	/** Frame where the consonant (or vowel, if there is none) begins. */
	consStart: number;
	/** Frame where the vowel begins — the 先行発声 anchor. */
	vowelOnset: number;
	/** Frame past which the vowel is steady. */
	stable: number;
	/** True when a voiced stop prevoiced into its burst. */
	prevoiced: boolean;
}

/**
 * Locate one mora inside `[from, to)`, given what consonant it starts with.
 */
export function locateMora(
	f: Frames,
	cls: ConsonantClass,
	from: number,
	to: number,
): MoraPosition {
	const art = ARTICULATION[cls];
	const consStart = findConsonantStart(
		f,
		from,
		to,
		art.fricationOnset,
		art.maxConsonantMs + 60,
	);
	const searchEnd = Math.min(
		to,
		consStart + msToFrame(art.maxConsonantMs + 60),
	);
	// The vowel should start within the consonant's own span; when it does not,
	// the voicing that begins anywhere before `to` is still a far better anchor
	// than a fixed distance from an attack that may itself have been misjudged.
	const voiceOnset = (): number => {
		const near = findVowelOnset(f, consStart, searchEnd);
		return near >= 0 ? near : findVowelOnset(f, searchEnd, to);
	};

	let vowelOnset: number;
	if (!art.voicedConsonant) {
		// Voiceless consonant: the vowel is exactly where the folds start.
		const v = voiceOnset();
		vowelOnset = v >= 0 ? v : consStart + msToFrame(30);
	} else if (cls === "vowel" || cls === "nasalN") {
		const v = voiceOnset();
		vowelOnset = v >= 0 ? v : consStart;
	} else {
		const voiceStart = findVoiceOnset(f, consStart, searchEnd);
		const base = voiceStart >= 0 ? voiceStart : consStart;
		// な/ま行 hold their nasal for a good 30–80 ms before releasing, so the
		// search has to start past the voicing onset — otherwise the onset itself
		// is the strongest thing in the window and wins.
		vowelOnset = findVoicedRelease(
			f,
			base + msToFrame(MIN_VOICED_CONSONANT_MS),
			Math.min(to, base + msToFrame(art.maxConsonantMs)),
		);
	}
	vowelOnset = clamp(vowelOnset, consStart, Math.max(consStart, to - 1));

	return {
		consStart,
		vowelOnset,
		stable: findVowelStable(f, vowelOnset, to),
		prevoiced:
			cls === "plosiveVoiced" && hasPrevoicing(f, consStart, vowelOnset),
	};
}

/** Round to the 0.001 ms oto.ini files conventionally carry. */
function round(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

/**
 * Offset for a mora that has silence in front of it: a little air before the
 * attack, but never so much that the consonant runs longer than its class
 * allows.
 */
function attackOffsetMs(cls: ConsonantClass, pos: MoraPosition): number {
	const art = ARTICULATION[cls];
	const vowelMs = frameTimeMs(pos.vowelOnset);
	let offsetMs = frameTimeMs(pos.consStart) - art.leadInMs;
	offsetMs = Math.max(offsetMs, vowelMs - art.maxConsonantMs);
	return clamp(offsetMs, 0, Math.max(0, vowelMs - 1));
}

/**
 * Turn frame positions into the five oto.ini numbers.
 *
 * `endFrame` is where the usable region stops; 右ブランク is always written in
 * its negative form (relative to the offset), which stays correct no matter how
 * much silence trails the file.
 */
function buildEntry(
	wav: string,
	alias: string,
	f: Frames,
	cls: ConsonantClass,
	pos: MoraPosition,
	endFrame: number,
): OtoEntry {
	const art = ARTICULATION[cls];

	const offsetMs = attackOffsetMs(cls, pos);
	const vowelMs = frameTimeMs(pos.vowelOnset);
	const pre = Math.max(1, vowelMs - offsetMs);

	let overlap: number;
	if (art.fixedOverlapMs !== undefined) {
		// Bare vowels have no consonant to hide a crossfade in, so the wiki lets
		// the overlap run past the (tiny) preutterance; plosives take their
		// negative closure gap. Neither scales with anything measured.
		overlap = art.fixedOverlapMs;
	} else {
		// "下限はどの発音であっても早くて15ミリ秒程度、上限は先行発声と同じ値くらい"
		overlap = clamp(
			art.overlapRatio * pre,
			Math.min(MIN_OVERLAP_MS, pre),
			Math.min(MAX_OVERLAP_MS, pre),
		);
	}

	// 子音部: through the vowel onset and on until the vowel is steady, so only
	// steady-state vowel ever gets stretched.
	const consonant = Math.max(
		pre + 10,
		Math.abs(overlap) + 10,
		frameTimeMs(pos.stable) - offsetMs,
	);

	// Keep at least a little stretchable vowel past the fixed region.
	const endMs = Math.max(frameTimeMs(endFrame), offsetMs + consonant + 30);
	const cutoff = -(Math.min(endMs, f.durationMs) - offsetMs);

	return {
		wav,
		alias,
		offset: round(offsetMs),
		consonant: round(consonant),
		cutoff: round(cutoff),
		pre: round(pre),
		overlap: round(overlap),
	};
}

/**
 * 単独音: one mora per file, one entry per alias.
 *
 * `aliases` lets a caller emit the usual family for a file — the bare kana plus
 * a `- か` head variant — all sharing the same measurements.
 */
export function estimateSolo(
	wav: string,
	f: Frames,
	syl: Syllable,
	aliases: string[],
): OtoEntry[] {
	const soundStart = findSoundStart(f, 0, f.n);
	const soundEnd = findSoundEnd(f, soundStart, f.n);
	const pos = locateMora(f, syl.cls, 0, soundEnd);
	const end = findDecayStart(f, pos.stable, soundEnd);
	return aliases.map((alias) => buildEntry(wav, alias, f, syl.cls, pos, end));
}

/**
 * A 母音結合 entry (`* あ`): a mid-phrase vowel taken from the steady part of
 * the note, with the long symmetric crossfade those aliases are used with.
 */
export function estimateVowelJoin(
	wav: string,
	f: Frames,
	syl: Syllable,
	alias: string,
): OtoEntry | null {
	const soundStart = findSoundStart(f, 0, f.n);
	const soundEnd = findSoundEnd(f, soundStart, f.n);
	const pos = locateMora(f, syl.cls, 0, soundEnd);
	const end = findDecayStart(f, pos.stable, soundEnd);

	// The wiki's values for 母音結合: 先行発声 50, オーバーラップ twice that, and
	// a 固定範囲 just past the crossfade. They only work if the note is long
	// enough to hold them.
	const pre = 50;
	const overlap = 100;
	const consonant = 110;
	// The entry begins exactly where the vowel settled: everything a 母音結合
	// alias plays is steady-state, with the preutterance sitting inside it.
	const offsetMs = frameTimeMs(pos.stable);
	const endMs = frameTimeMs(end);
	if (offsetMs < 0 || endMs - offsetMs < consonant + 40) return null;

	return {
		wav,
		alias,
		offset: round(offsetMs),
		consonant,
		cutoff: round(-(endMs - offsetMs)),
		pre,
		overlap,
	};
}

/** A 連続音 recording's rhythmic grid. */
export interface Grid {
	/** Frame of the first mora's onset. */
	start: number;
	/** Frames between successive moras. */
	interval: number;
	/** Per-mora onset frames, snapped to the strongest nearby transition. */
	onsets: number[];
}

/** How far a snapped onset may pull away from the fitted tempo line. */
const GRID_SNAP_WEIGHT = 0.6;

/** Least-squares line through (index, value) pairs. */
function fitLine(values: readonly number[]): {
	intercept: number;
	slope: number;
} {
	const n = values.length;
	if (n < 2) return { intercept: values[0] ?? 0, slope: 0 };
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		sx += i;
		sy += values[i];
		sxx += i * i;
		sxy += i * values[i];
	}
	const denom = n * sxx - sx * sx;
	const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
	return { intercept: (sy - slope * sx) / n, slope };
}

/** Combined onset strength: spectral change plus a local rise in level. */
function onsetStrength(f: Frames): Float32Array {
	const k = Math.max(1, msToFrame(12));
	const out = new Float32Array(f.n);
	for (let t = 0; t < f.n; t++) {
		const rise =
			f.smoothDb[Math.min(f.n - 1, t + k)] - f.smoothDb[Math.max(0, t - k)];
		out[t] = f.flux[t] + Math.max(0, rise) / 3;
	}
	return smooth(out, Math.max(1, msToFrame(8)));
}

/**
 * Fit `count` evenly spaced moras to the recording.
 *
 * 連続音 lists are sung to a guide BGM, so the moras land on a metronomic grid —
 * which is exactly why the wiki treats 連続音 oto as something you *generate*
 * and then touch up. Fitting a global tempo first, and only then snapping each
 * mora to the nearest real transition, keeps one mis-detected onset from
 * dragging the rest of the file out of alignment.
 */
export function detectGrid(
	f: Frames,
	count: number,
	/**
	 * Mora interval to fit around instead of measuring one. A file of glides
	 * (`_うぃうぉうぃううぇ`) has onsets too weak to autocorrelate, and the tempo
	 * the rest of the folder was sung at is a far better guess than a
	 * sub-multiple picked out of its own noise.
	 */
	hintFrames?: number,
): Grid | null {
	if (count < 1) return null;
	const strength = onsetStrength(f);
	const uttStart = findSoundStart(f, 0, f.n);
	const uttEnd = findSoundEnd(f, uttStart, f.n);
	const span = uttEnd - uttStart;
	if (span < msToFrame(80)) return null;

	if (count === 1) {
		return { start: uttStart, interval: span, onsets: [uttStart] };
	}

	const candidates =
		hintFrames !== undefined && hintFrames > 0
			? [hintFrames]
			: intervalCandidates(strength, uttStart, uttEnd, span / count);
	const best = { score: -Infinity, start: uttStart, interval: span / count };
	const search = (requireFit: boolean): void => {
		for (const candidate of candidates) {
			for (
				let iv = candidate * 0.85;
				iv <= candidate * 1.18;
				iv += candidate * 0.02
			) {
				// Every grid point looks for its onset in a window of the same width,
				// so one sliding-window maximum serves the whole phase sweep.
				const near = windowArgMax(strength, Math.round(iv * 0.22));
				const tol = iv * 0.22;
				const hardEnd = uttEnd + iv * 0.4;
				for (
					let phase = uttStart - iv * 0.25;
					phase <= uttStart + iv * 0.5;
					phase += 1
				) {
					if (requireFit && phase + (count - 1) * iv > hardEnd) break;
					let total = 0;
					for (let i = 0; i < count; i++) {
						const centre = phase + i * iv;
						const at = near[clamp(Math.round(centre), 0, f.n - 1)];
						total += strength[at] - Math.abs(at - centre) / tol;
					}
					if (total > best.score) {
						best.score = total;
						best.start = phase;
						best.interval = iv;
					}
				}
			}
		}
	};

	// Normally every mora has to fit inside the utterance. When none of the
	// candidate tempos can manage that — a phrase sung faster at the end, or an
	// utterance whose tail the threshold clipped — a grid that overruns is still
	// far better than no entries at all for the file.
	search(true);
	if (!Number.isFinite(best.score)) search(false);
	if (!Number.isFinite(best.score)) return null;

	const near = windowArgMax(strength, Math.round(best.interval * 0.25));
	const snapped: number[] = [];
	for (let i = 0; i < count; i++) {
		snapped.push(
			near[clamp(Math.round(best.start + i * best.interval), 0, f.n - 1)],
		);
	}

	// Refit the tempo to where the onsets actually landed, then pull each one
	// back toward that line. A vowel-to-vowel join has no attack to lock onto and
	// its peak wanders; the singer's own timing does not.
	const { intercept, slope } = fitLine(snapped);
	const onsets: number[] = [];
	for (let i = 0; i < count; i++) {
		const fitted = intercept + slope * i;
		const blended = Math.round(
			fitted + (snapped[i] - fitted) * GRID_SNAP_WEIGHT,
		);
		onsets.push(i > 0 ? Math.max(blended, onsets[i - 1] + 4) : blended);
	}

	return {
		start: onsets[0],
		interval: slope > 0 ? slope : best.interval,
		onsets,
	};
}

/**
 * For every index, the index of the largest value within ±`half` of it.
 * A monotonic deque keeps this linear regardless of the window width.
 */
function windowArgMax(src: Float32Array, half: number): Int32Array {
	const n = src.length;
	const out = new Int32Array(n);
	const deque = new Int32Array(n);
	let head = 0;
	let tail = 0;
	let next = 0;
	for (let i = 0; i < n; i++) {
		const limit = Math.min(n - 1, i + half);
		while (next <= limit) {
			while (tail > head && src[deque[tail - 1]] <= src[next]) tail--;
			deque[tail++] = next++;
		}
		while (deque[head] < i - half) head++;
		out[i] = deque[head];
	}
	return out;
}

/**
 * Plausible mora intervals, in frames.
 *
 * Dividing the utterance by the mora count only works when the recording stops
 * shortly after the last mora; plenty of lists hold the final vowel for a
 * second or more, which inflates the estimate past any sane tempo. Auto-
 * correlating the onset track measures the beat directly instead, and its
 * *shortest* strong peak is the beat rather than a multiple of it.
 */
function intervalCandidates(
	strength: Float32Array,
	from: number,
	to: number,
	fromSpan: number,
): number[] {
	const lo = msToFrame(180);
	const hi = Math.min(msToFrame(1300), Math.floor((to - from) / 2));
	const out: number[] = [];
	if (hi > lo) {
		let mean = 0;
		for (let t = from; t < to; t++) mean += strength[t];
		mean /= Math.max(1, to - from);

		const r = new Float64Array(hi + 1);
		let peak = 0;
		for (let lag = lo; lag <= hi; lag++) {
			let sum = 0;
			let n = 0;
			for (let t = from; t + lag < to; t++, n++) {
				sum += (strength[t] - mean) * (strength[t + lag] - mean);
			}
			r[lag] = n > 0 ? sum / n : 0;
			if (r[lag] > peak) peak = r[lag];
		}
		if (peak > 0) {
			for (let lag = lo + 1; lag < hi; lag++) {
				if (r[lag] < peak * 0.7) continue;
				if (r[lag] < r[lag - 1] || r[lag] < r[lag + 1]) continue;
				out.push(lag);
				if (out.length >= 2) break;
			}
		}
	}
	out.push(fromSpan);

	// Every peak's halves and thirds go in too. A list where every other mora is
	// a weak ん correlates most strongly at *two* moras, and nothing but trying
	// the sub-multiple tells the two apart — the grid score then picks.
	const withSubmultiples: number[] = [];
	const seen = new Set<number>();
	const shortest = msToFrame(150);
	for (const c of out) {
		for (const divisor of [1, 2, 3]) {
			const key = Math.round(c / divisor);
			if (key < shortest || seen.has(key)) continue;
			seen.add(key);
			withSubmultiples.push(key);
		}
	}
	// An utterance too short for even one plausible interval still has to yield
	// a grid; the caller has moras to place either way.
	if (withSubmultiples.length === 0) withSubmultiples.push(shortest);
	return withSubmultiples;
}

/**
 * Where a mora's vowel starts *inside* a phrase, where nothing is silent.
 *
 * A voiceless consonant still cuts the voicing, so the vowel begins when the
 * folds come back. Everything else — a vowel following a vowel, a nasal, a
 * glide — never stops phonating, and its boundary is the transition itself,
 * which is what the grid already snapped to.
 */
function sequenceVowelOnset(
	f: Frames,
	cls: ConsonantClass,
	onset: number,
	next: number,
): number {
	if (ARTICULATION[cls].voicedConsonant) return onset + SEQUENCE_ONSET_BIAS;

	const lo = Math.max(0, onset - msToFrame(100));
	const hi = Math.min(next, onset + msToFrame(150));
	let quietest = onset;
	for (let t = lo; t < hi; t++) {
		if (f.voiced[t] < f.voiced[quietest]) quietest = t;
	}
	if (f.voiced[quietest] >= VOICED_THRESHOLD) return onset;

	const resumed = findVowelOnset(
		f,
		quietest,
		Math.min(next, hi + msToFrame(80)),
	);
	return resumed >= 0 ? resumed : onset;
}

/**
 * 連続音: every mora in the file gets an entry, aliased against the vowel it
 * follows (`a か`), with the first written as a phrase head (`- あ`).
 *
 * The template — 先行発声 at half the mora interval, オーバーラップ at a third of
 * that, 固定範囲 half again as long, 右ブランク two thirds of an interval past the
 * note — is the one the established 連続音 banks ship, and it survives a mora
 * whose consonant is longer than average because half an interval is far more
 * room than any Japanese onset needs.
 */
export function estimateSequence(
	wav: string,
	f: Frames,
	syllables: Syllable[],
	opts: SequenceOptions = {},
): OtoEntry[] {
	return estimateSequenceDetail(wav, f, syllables, opts).entries;
}

export interface SequenceOptions {
	suffix?: string;
	prefix?: string;
	/**
	 * The filename ended in an R/息 marker, so the file was recorded with a
	 * deliberate release into silence. The `a R` entry is written either way;
	 * this only says the file is the better source for it.
	 */
	trailingRest?: boolean;
	/** Skip the `a R` entry. Default: write it. */
	restAlias?: boolean;
	/** Mora interval to fit around, in ms — see {@link detectGrid}. */
	intervalHintMs?: number;
}

/** {@link estimateSequence}, plus the tempo the file was fitted at. */
export function estimateSequenceDetail(
	wav: string,
	f: Frames,
	syllables: Syllable[],
	opts: SequenceOptions = {},
): { entries: OtoEntry[]; intervalMs: number } {
	const grid = detectGrid(
		f,
		syllables.length,
		opts.intervalHintMs === undefined
			? undefined
			: msToFrame(opts.intervalHintMs),
	);
	if (!grid) return { entries: [], intervalMs: 0 };

	const intervalMs = framesToMs(grid.interval);
	// Half an interval, but never more than 250 ms — which is both what every
	// reference bank writes and far more room than any Japanese onset needs.
	const pre = clamp(intervalMs / 2, 60, MAX_SEQUENCE_PRE_MS);
	const overlap = round(pre / 3);
	const consonant = round(pre * 1.5);
	const suffix = opts.suffix ?? "";
	// A head marker describes how the phrase *starts*, so it belongs on the
	// phrase-head alias and nowhere else.
	const prefix = opts.prefix ?? "";

	const entries: OtoEntry[] = [];
	for (let i = 0; i < syllables.length; i++) {
		const syl = syllables[i];
		const onset = grid.onsets[i];
		const next =
			i + 1 < syllables.length
				? grid.onsets[i + 1]
				: findSoundEnd(f, onset, f.n);

		let noteMs: number;
		let offsetMs: number;
		if (i === 0) {
			// The phrase head is the one mora with real silence in front of it, so
			// it is measured the same way a 単独音 file is — and its offset goes
			// just ahead of the attack rather than half an interval back. Half an
			// interval reaches into the breath the singer took before the phrase,
			// which then plays as the note.
			const pos = locateMora(f, syl.cls, 0, next);
			noteMs = frameTimeMs(pos.vowelOnset);
			offsetMs = attackOffsetMs(syl.cls, pos);
		} else {
			noteMs = frameTimeMs(sequenceVowelOnset(f, syl.cls, onset, next));
			offsetMs = clamp(noteMs - pre, 0, Math.max(0, noteMs - 1));
		}

		const actualPre = noteMs - offsetMs;
		// 右ブランク reaches two thirds of an interval past the note, so each mora's
		// tail is still there for the next one to cross-fade into.
		const endMs = Math.min(f.durationMs, noteMs + (intervalMs * 2) / 3);

		const alias =
			i === 0
				? `- ${prefix}${syl.kana}${suffix}`
				: `${syllables[i - 1].vowel} ${syl.kana}${suffix}`;

		entries.push({
			wav,
			alias,
			offset: round(offsetMs),
			consonant: Math.max(round(consonant), round(actualPre + 20)),
			cutoff: round(-Math.max(endMs - offsetMs, consonant + 40)),
			pre: round(actualPre),
			overlap: i === 0 ? 0 : Math.min(overlap, round(actualPre)),
		});
	}

	// Every 連続音 file ends with a vowel released into silence, and that
	// release is what a phrase-final `a R` plays. The reference banks write one
	// from their `_ああR`-style files only because those are the takes where the
	// singer let go cleanly; a bank recorded without them still needs the alias,
	// or every note before a rest is chopped by the wavtool's 35 ms fade.
	if (opts.restAlias !== false && syllables.length > 0) {
		const last = syllables[syllables.length - 1];
		const lastOnset = grid.onsets[syllables.length - 1];
		const soundEnd = findSoundEnd(f, lastOnset, f.n);
		const decay = findDecayStart(f, lastOnset, soundEnd);
		const noteMs = frameTimeMs(decay);
		const offsetMs = clamp(noteMs - pre, 0, Math.max(0, noteMs - 1));
		const actualPre = noteMs - offsetMs;
		entries.push({
			wav,
			alias: `${last.vowel} R${suffix}`,
			offset: round(offsetMs),
			consonant: round(consonant),
			cutoff: round(
				-(Math.min(f.durationMs, frameTimeMs(soundEnd)) - offsetMs),
			),
			pre: round(actualPre),
			overlap: Math.min(overlap, round(actualPre)),
		});
	}

	return { entries, intervalMs };
}
