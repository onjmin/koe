import type { FeatureFrame } from "./openjtalk_features.js";

/**
 * Prosody transplant from an HTS voice (Open JTalk's statistical model, run by
 * jbonsai inside the jpreprocess wasm): HTS decides *how long* each mora is and
 * *what pitch contour* the sentence has; the UTAU voice bank only supplies the
 * timbre. This is the same division of labour as Cantari (VOICEVOX prosody +
 * worldline) but with a 1-2 MB model that runs in the browser.
 */

/** One phoneme of the HTS timeline (`analyze_prosody` output). */
export interface HtsPhoneme {
	phone: string;
	start_ms: number;
	duration_ms: number;
}

/** Raw `analyze_prosody` result. */
export interface HtsProsodyFrames {
	frame_ms: number;
	sample_rate: number;
	phonemes: HtsPhoneme[];
	/** F0 in Hz per frame; 0 = unvoiced. */
	f0_hz: number[];
}

/** HTS prosody aligned to the UtauTTS mora sequence, ready for `plan()`. */
export interface HtsProsody {
	/** Per feature-frame (mora or pause) duration in ms, same order as the features. */
	moraDurationsMs: number[];
	/** Cents relative to the speaker median, on the plan time axis (0 = first mora onset). */
	pitchCurve: { frame_ms: number; cents: number[] };
	/** Median voiced F0 of the HTS utterance in Hz. */
	medianHz: number;
	/** Total planned duration in ms (sum of `moraDurationsMs`). */
	durationMs: number;
	/**
	 * Per feature-frame flag: HTS predicted the mora nucleus as a devoiced vowel
	 * (Open JTalk's upper-case `I`/`U`, e.g. the "su" in "desu"). Pauses are false.
	 */
	devoiced: boolean[];
	/**
	 * Per feature-frame HTS consonant length in ms (onset of the mora's first
	 * phone to its vowel onset); 0 for pauses and vowel-initial morae. The
	 * planner uses it to end the previous vowel where the consonant starts.
	 */
	consonantMs: number[];
	/** Per feature-frame flag: the mora starts with an unvoiced consonant (k, s, t, h, p …). */
	unvoicedOnset: boolean[];
	/**
	 * Optional per feature-frame linear gain (1 = unity) applied to the units of
	 * that mora on top of UtauTTS's own volume; filled by `shapeProsody`.
	 */
	moraGains?: number[];
}

export interface AlignHtsOptions {
	/** Multiplier on the cents curve. 1 = HTS as-is. Default 1. */
	intonationStrength?: number;
	/** Output frame period for the pitch curve in ms. Default 10 (worldline's frame). */
	frameMs?: number;
	/** Pause length used when the features have a pause HTS did not produce. Default 150. */
	fallbackPauseMs?: number;
	/**
	 * Soft limit for the cents curve: excursions beyond `kneeCents` are halved,
	 * then hard-clamped at `maxCents`. HTS voices end phrases with a creaky
	 * drop of close to an octave, which WORLD resynthesis of a singing sample
	 * cannot follow cleanly. Defaults: knee 400, max 700.
	 */
	kneeCents?: number;
	maxCents?: number;
	/**
	 * Longest unvoiced run (ms) that is bridged by interpolating F0 from the
	 * voiced frame before it to the one after it. Unvoiced consonants (30–120
	 * ms) are bridged; a longer run is a devoiced vowel plus a pause plus the
	 * next phrase's consonant, and a ramp across it would carry the *next*
	 * phrase's onset pitch back onto the devoiced mora (「ございます」 rendered
	 * with a rising 「す」, since UTAU renders devoiced vowels voiced). Such
	 * runs hold the previous value over their first half and the following
	 * value over their second half. Default 120.
	 */
	unvoicedBridgeMs?: number;
}

/** Mora nuclei in Open JTalk phoneme notation (upper case = devoiced vowel). */
const NUCLEUS = new Set([
	"a",
	"i",
	"u",
	"e",
	"o",
	"A",
	"I",
	"U",
	"E",
	"O",
	"N",
	"cl",
]);

/** Halve excursions beyond ±knee, then clamp at ±max (keeps the shape, tames the extremes). */
function softLimit(value: number, knee: number, max: number): number {
	const magnitude = Math.abs(value);
	const limited =
		magnitude <= knee ? magnitude : knee + (magnitude - knee) * 0.5;
	return Math.sign(value) * Math.min(max, limited);
}

interface Segment {
	pause: boolean;
	/** Consonant onset (pause start for pauses). */
	startMs: number;
	/** Vowel (nucleus) onset; equals `startMs` for pauses and bare consonants. */
	nucleusMs: number;
	endMs: number;
	/** Nucleus was an upper-case (devoiced) vowel. */
	devoiced: boolean;
	/** First phone of the mora ("" for pauses and vowel-initial morae). */
	onset: string;
}

const DEVOICED = new Set(["A", "I", "U", "E", "O"]);

/** Open JTalk consonants with no voicing: the F0 jump across them is inaudible in speech. */
const UNVOICED_ONSET = new Set([
	"k",
	"ky",
	"s",
	"sh",
	"t",
	"ty",
	"ch",
	"ts",
	"h",
	"hy",
	"f",
	"p",
	"py",
]);

/** Group HTS phonemes into morae / pauses. Leading `sil` is dropped, trailing `sil` becomes a pause. */
function segmentPhonemes(phonemes: HtsPhoneme[]): Segment[] {
	const segments: Segment[] = [];
	let openStart: number | null = null;
	let openOnset = "";
	for (let i = 0; i < phonemes.length; i++) {
		const { phone, start_ms, duration_ms } = phonemes[i];
		if (phone === "sil" || phone === "pau") {
			if (openStart !== null) {
				// Consonant without a nucleus (should not happen): fold into a mora.
				segments.push({
					pause: false,
					startMs: openStart,
					nucleusMs: openStart,
					endMs: start_ms,
					devoiced: false,
					onset: openOnset,
				});
				openStart = null;
			}
			if (i === 0) continue;
			segments.push({
				pause: true,
				startMs: start_ms,
				nucleusMs: start_ms,
				endMs: start_ms + duration_ms,
				devoiced: false,
				onset: "",
			});
			continue;
		}
		if (openStart === null) {
			openStart = start_ms;
			openOnset = NUCLEUS.has(phone) ? "" : phone;
		}
		if (NUCLEUS.has(phone)) {
			segments.push({
				pause: false,
				startMs: openStart,
				nucleusMs: start_ms,
				endMs: start_ms + duration_ms,
				devoiced: DEVOICED.has(phone),
				onset: openOnset,
			});
			openStart = null;
		}
	}
	if (openStart !== null) {
		const last = phonemes[phonemes.length - 1];
		segments.push({
			pause: false,
			startMs: openStart,
			nucleusMs: openStart,
			endMs: last.start_ms + last.duration_ms,
			onset: openOnset,
			devoiced: false,
		});
	}
	return segments;
}

/**
 * Where a segment sits on the mora grid: a mora's note starts at its vowel
 * onset (UTAU note semantics: the consonant is pre-uttered before the note),
 * a pause at its own start.
 */
function anchorMs(segment: Segment): number {
	return segment.pause ? segment.startMs : segment.nucleusMs;
}

/**
 * Align HTS phoneme timing and F0 to the mora/pause sequence in `features`
 * (from `openjtalkAnalyze`). Returns null when the two mora sequences cannot
 * be matched, in which case the caller should fall back to the TCN contour.
 *
 * Mora boundaries are the HTS *vowel onsets*: a mora's duration runs from its
 * vowel onset to the next mora's vowel onset (so the next consonant belongs to
 * the end of this mora), which is how UtauTTS places units (note start =
 * vowel onset, consonant pre-uttered). Cutting at consonant onsets instead
 * would delay the F0 contour by one consonant (40–120 ms) relative to the
 * rendered vowels and shift every accent fall onto the following mora.
 */
export function alignHtsProsody(
	frames: HtsProsodyFrames,
	features: FeatureFrame[],
	options: AlignHtsOptions = {},
): HtsProsody | null {
	const {
		intonationStrength = 1,
		frameMs = 10,
		fallbackPauseMs = 150,
		kneeCents = 400,
		maxCents = 700,
		unvoicedBridgeMs = 120,
	} = options;
	const segments = segmentPhonemes(frames.phonemes);

	// Two-pointer walk: morae must pair 1:1; pauses may be missing on either side.
	const matched: (number | null)[] = new Array(features.length).fill(null);
	const devoiced: boolean[] = new Array(features.length).fill(false);
	const consonantMs: number[] = new Array(features.length).fill(0);
	const unvoicedOnset: boolean[] = new Array(features.length).fill(false);
	let s = 0;
	for (let f = 0; f < features.length; f++) {
		const feature = features[f];
		while (s < segments.length && segments[s].pause && !feature.pause) s++; // HTS pause the features lack
		const segment = segments[s];
		if (feature.pause) {
			if (segment?.pause) matched[f] = s++;
			// else: features pause HTS lacks (e.g. unreadable token) → fallback below
			continue;
		}
		if (!segment) return null;
		matched[f] = s++;
		devoiced[f] = segment.devoiced;
		consonantMs[f] = Math.max(0, segment.nucleusMs - segment.startMs);
		unvoicedOnset[f] = UNVOICED_ONSET.has(segment.onset);
	}
	if (segments.slice(s).some((segment) => !segment.pause)) return null; // HTS has morae left over

	// Durations between consecutive anchors; HTS pauses the features skipped
	// are cut out so a mora does not stretch across them.
	const durations: number[] = new Array(features.length).fill(0);
	const htsStart: (number | null)[] = new Array(features.length).fill(null);
	for (let f = 0; f < features.length; f++) {
		const index = matched[f];
		if (index === null) {
			durations[f] = fallbackPauseMs;
			continue;
		}
		const here = anchorMs(segments[index]);
		let next = f + 1;
		while (next < features.length && matched[next] === null) next++;
		let end = segments[index].endMs;
		if (next < features.length) {
			const nextIndex = matched[next] as number;
			end = anchorMs(segments[nextIndex]);
			for (let k = index + 1; k < nextIndex; k++) {
				if (segments[k].pause) end -= segments[k].endMs - segments[k].startMs;
			}
		}
		durations[f] = Math.max(0, end - here);
		htsStart[f] = here;
	}

	// HTS voices often call unvoiced consonants voiced (tohoku-f01 gives 「h」
	// and 「t」 an F0 track), which would carry the pitch movement of the
	// consonant into the rendered vowel. Treat frames inside phonologically
	// unvoiced consonants as unvoiced so the hold-then-ramp bridging applies.
	const f0 = frames.f0_hz.slice();
	for (const phoneme of frames.phonemes) {
		if (!UNVOICED_ONSET.has(phoneme.phone) && phoneme.phone !== "cl") continue;
		const from = Math.max(0, Math.round(phoneme.start_ms / frames.frame_ms));
		const to = Math.min(
			f0.length,
			Math.round((phoneme.start_ms + phoneme.duration_ms) / frames.frame_ms),
		);
		for (let i = from; i < to; i++) f0[i] = 0;
	}

	// Continuous F0 in log2 domain (interpolate across unvoiced runs, hold at edges).
	const logF0 = new Float64Array(f0.length);
	const voiced: number[] = [];
	for (let i = 0; i < f0.length; i++) if (f0[i] > 0) voiced.push(i);
	if (voiced.length === 0) return null;
	const sorted = voiced.map((i) => f0[i]).sort((a, b) => a - b);
	const medianHz = sorted[Math.floor(sorted.length / 2)];
	for (let i = 0, v = 0; i < f0.length; i++) {
		if (f0[i] > 0) {
			logF0[i] = Math.log2(f0[i]);
			continue;
		}
		while (v < voiced.length && voiced[v] < i) v++;
		const right = voiced[v];
		const left = v > 0 ? voiced[v - 1] : undefined;
		if (left === undefined) logF0[i] = Math.log2(f0[right]);
		else if (right === undefined) logF0[i] = Math.log2(f0[left]);
		else {
			if ((right - left) * frames.frame_ms > unvoicedBridgeMs) {
				// Pause-sized gap: no ramp; switch from the previous to the next value at the midpoint.
				logF0[i] = Math.log2(
					i - left <= (right - left) / 2 ? f0[left] : f0[right],
				);
				continue;
			}
			// Unvoiced consonant: hold the previous value and move only in the
			// last ~20 ms before the next vowel. In speech the jump hides inside
			// the consonant; a ramp across the whole gap would be rendered as a
			// glide inside the preceding vowel (UTAU vowels run up to the next
			// consonant), which sounds sing-song.
			const rampStart = Math.max(left, right - Math.ceil(20 / frames.frame_ms));
			if (i <= rampStart) {
				logF0[i] = Math.log2(f0[left]);
				continue;
			}
			const t = (i - rampStart) / (right - rampStart);
			logF0[i] = Math.log2(f0[left]) * (1 - t) + Math.log2(f0[right]) * t;
		}
	}
	const logMedian = Math.log2(medianHz);
	const htsCentsAt = (tMs: number): number => {
		const position = Math.max(0, tMs) / frames.frame_ms;
		const left = Math.min(logF0.length - 1, Math.floor(position));
		const right = Math.min(logF0.length - 1, left + 1);
		const t = position - Math.floor(position);
		return (logF0[left] * (1 - t) + logF0[right] * t - logMedian) * 1200;
	};

	// Plan time axis: morae start at the cumulative sum of the assigned durations.
	const planStart: number[] = [];
	let cursor = 0;
	for (let f = 0; f < features.length; f++) {
		planStart.push(cursor);
		cursor += durations[f];
	}
	const durationMs = cursor;
	const count = Math.max(2, Math.ceil(durationMs / frameMs) + 2);
	const cents = new Array<number>(count);
	let f = 0;
	for (let frame = 0; frame < count; frame++) {
		const tMs = frame * frameMs;
		while (f + 1 < features.length && tMs >= planStart[f + 1]) f++;
		const start = htsStart[f];
		// Pauses HTS did not produce have no HTS time: hold the value at the next mora onset.
		let htsMs: number;
		if (start !== null) htsMs = start + (tMs - planStart[f]);
		else {
			const next = htsStart.slice(f + 1).find((value) => value !== null);
			htsMs = next ?? frames.phonemes.at(-1)?.start_ms ?? 0;
		}
		cents[frame] = softLimit(
			htsCentsAt(htsMs) * intonationStrength,
			kneeCents,
			maxCents,
		);
	}
	return {
		moraDurationsMs: durations,
		pitchCurve: { frame_ms: frameMs, cents },
		medianHz,
		durationMs,
		devoiced,
		consonantMs,
		unvoicedOnset,
	};
}
