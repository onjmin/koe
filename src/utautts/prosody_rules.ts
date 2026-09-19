import type { HtsProsody } from "./hts.js";
import {
	type FeatureFrame,
	type PauseKind,
	pauseKind,
} from "./openjtalk_features.js";

/**
 * Rule-based residuals on top of the HTS prosody (a cut-down Fujisaki-style
 * layer): the statistical model gives the accent shape, these rules add what
 * the HTS voices were not trained for and what a concatenative voice bank
 * lacks on its own.
 *
 *  - question rise: a sentence ending in 「？」 gets at least a minimum rise
 *    on its last mora; Open JTalk's interrogative label flag already makes
 *    tohoku-f01 rise, so this only tops up voices/sentences that do not
 *  - energy envelope (off by default, see `energyDbPerSemitone`): loudness
 *    follows pitch per mora; the renderer now does this smoothly per frame
 *  - devoiced vowels: morae HTS predicted as devoiced (「です」「ます」…) are
 *    attenuated so the voiced sample does not shout a vowel the speaker
 *    would whisper
 *  - pause length by punctuation: the HTS voice was trained on single
 *    sentences, so it gives 「。」 and 「、」 the same ~300 ms; a reading voice
 *    pauses roughly twice as long at a sentence end
 *  - duration contrast: HTS durations are variance-shrunk (over-smoothed);
 *    stretching them around the utterance mean restores some of the
 *    short-particle / long-final-mora rhythm of natural speech
 *
 * Zero assets, negligible compute; everything is mora-level arithmetic.
 */
export interface ShapeProsodyOptions {
	/**
	 * Minimum pause length in ms per pause kind (see `pauseKind`); the HTS
	 * pause is kept when it is already longer. The utterance-final pause is
	 * left alone. `null` disables the rule. Defaults: sentence 650, clause 380,
	 * space 500.
	 */
	pauseMs?: Partial<Record<PauseKind, number>> | null;
	/**
	 * Expansion of spoken-mora durations around the utterance mean:
	 * `mean + (d − mean) × contrast`. 1 keeps HTS as-is. Default 1.3.
	 */
	durationContrast?: number;
	/** Floor for a spoken mora after contrast expansion, in ms. Default 60. */
	minMoraMs?: number;
	/**
	 * A mora is never shortened below this fraction of its HTS duration by the
	 * contrast expansion (short morae such as devoiced 「く」 are already at
	 * their minimum). Default 0.85.
	 */
	minShrink?: number;
	/** Baseline pitch shift added to the whole curve, in cents. Default 0. */
	pitchShiftCents?: number;
	/** Treat the utterance as a question (see {@link isQuestion}). Default false. */
	question?: boolean;
	/**
	 * Minimum rise across the final mora of a question, in cents. Open JTalk
	 * labels carry an interrogative flag and HTS voices trained with it (e.g.
	 * tohoku-f01) already rise; the rule only tops up whatever is missing, so
	 * it is a safety net for voices/sentences where the rise does not appear.
	 * Default 350.
	 */
	questionRiseCents?: number;
	/**
	 * Per-mora loudness coupling: dB per 100 cents of pitch relative to the
	 * speaker median, applied as a step per mora through `moraGains`. Default
	 * 0: `UtauTTSAdapter.renderChunks` applies the same coupling as a smooth
	 * per-frame curve (`energyDbPerSemitone` there), which avoids level steps
	 * at the mora joins. Set this when rendering through something else.
	 */
	energyDbPerSemitone?: number;
	/**
	 * Linear gain for morae with a devoiced nucleus, applied to the whole unit
	 * through `moraGains`. Default 1: `UtauTTSAdapter.renderChunks` attenuates
	 * only the vowel part of a devoiced mora (`devoicedDb`), keeping the
	 * consonant burst audible; set this when rendering through something else.
	 */
	devoicedGain?: number;
	/** Clamp for the per-mora gain. Defaults 0.35 … 1.8. */
	minGain?: number;
	maxGain?: number;
}

/** Closing brackets/quotes/spaces that may follow the final punctuation. */
const TRAILING = /[\s」』）)〕】＞>"'”’]+$/u;

/** True when the text ends with a question mark (「？」 or "?"), ignoring closing quotes. */
export function isQuestion(text: string): boolean {
	return /[？?]$/u.test(text.replace(TRAILING, ""));
}

function smoothstep(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x * x * (3 - 2 * x);
}

const DEFAULT_PAUSE_MS: Record<PauseKind, number> = {
	sentence: 650,
	clause: 380,
	space: 500,
};

/**
 * New per-frame durations: pauses lengthened by kind, spoken morae expanded
 * around the mean. Pure; returns `durations` itself when nothing changes.
 */
export function shapeDurations(
	durations: number[],
	features: FeatureFrame[],
	options: Pick<
		ShapeProsodyOptions,
		"pauseMs" | "durationContrast" | "minMoraMs" | "minShrink"
	> = {},
): number[] {
	const {
		pauseMs = DEFAULT_PAUSE_MS,
		durationContrast = 1.3,
		minMoraMs = 60,
		minShrink = 0.85,
	} = options;
	const count = Math.min(features.length, durations.length);
	let sum = 0;
	let spoken = 0;
	for (let f = 0; f < count; f++) {
		if (features[f].pause) continue;
		sum += durations[f];
		spoken++;
	}
	const mean = spoken > 0 ? sum / spoken : 0;
	const result = durations.slice();
	let changed = false;
	for (let f = 0; f < count; f++) {
		const feature = features[f];
		let next = durations[f];
		if (feature.pause) {
			if (pauseMs && f < count - 1) {
				const kind = pauseKind(feature.punctuation);
				next = Math.max(next, pauseMs[kind] ?? DEFAULT_PAUSE_MS[kind]);
			}
		} else if (durationContrast !== 1 && next > 0) {
			next = Math.max(
				Math.min(next, minMoraMs),
				next * minShrink,
				mean + (next - mean) * durationContrast,
			);
		}
		if (next !== durations[f]) {
			result[f] = next;
			changed = true;
		}
	}
	return changed ? result : durations;
}

/**
 * Re-time a cents curve from the `from` durations to the `to` durations with
 * a piecewise-linear warp (each frame keeps its own contour, stretched or
 * squeezed to its new length). Frame period unchanged.
 */
export function warpPitchCurve(
	cents: number[],
	frameMs: number,
	from: number[],
	to: number[],
): number[] {
	const count = Math.min(from.length, to.length);
	const fromStart: number[] = [];
	const toStart: number[] = [];
	let a = 0;
	let b = 0;
	for (let f = 0; f < count; f++) {
		fromStart.push(a);
		toStart.push(b);
		a += from[f];
		b += to[f];
	}
	const frames = Math.max(2, Math.ceil(b / frameMs) + 2);
	const result = new Array<number>(frames);
	const last = cents.length - 1;
	if (last < 0) return result.fill(0);
	let f = 0;
	for (let frame = 0; frame < frames; frame++) {
		const tMs = frame * frameMs;
		while (f + 1 < count && tMs >= toStart[f + 1]) f++;
		const progress = to[f] > 0 ? (tMs - toStart[f]) / to[f] : 0;
		const source = (fromStart[f] + progress * from[f]) / frameMs;
		const left = Math.min(last, Math.max(0, Math.floor(source)));
		const right = Math.min(last, left + 1);
		const t = Math.min(1, Math.max(0, source - Math.floor(source)));
		result[frame] = cents[left] * (1 - t) + cents[right] * t;
	}
	return result;
}

/**
 * Apply the residual rules to an aligned HTS prosody. Returns a new object;
 * `prosody` is not modified. Pass the result to `plan({ prosody })`: the pitch
 * curve carries the question rise, `moraGains` the energy envelope.
 */
export function shapeProsody(
	prosody: HtsProsody,
	features: FeatureFrame[],
	options: ShapeProsodyOptions = {},
): HtsProsody {
	const {
		question = false,
		questionRiseCents = 350,
		energyDbPerSemitone = 0,
		devoicedGain = 1,
		minGain = 0.35,
		maxGain = 1.8,
		pitchShiftCents = 0,
	} = options;
	const { frame_ms: frameMs } = prosody.pitchCurve;

	// ── Durations: pause by punctuation kind, contrast expansion; warp the curve to match ──
	const durations = shapeDurations(prosody.moraDurationsMs, features, options);
	const cents =
		durations === prosody.moraDurationsMs
			? prosody.pitchCurve.cents.slice()
			: warpPitchCurve(
					prosody.pitchCurve.cents,
					frameMs,
					prosody.moraDurationsMs,
					durations,
				);
	const count = Math.min(features.length, durations.length);

	// Mora boundaries on the plan time axis, in frames.
	const startFrame: number[] = [];
	const endFrame: number[] = [];
	let cursor = 0;
	for (let f = 0; f < count; f++) {
		startFrame.push(cursor / frameMs);
		cursor += durations[f];
		endFrame.push(cursor / frameMs);
	}
	for (let f = count; f < durations.length; f++) cursor += durations[f];
	const durationMs = cursor;
	if (pitchShiftCents !== 0) {
		for (let frame = 0; frame < cents.length; frame++)
			cents[frame] += pitchShiftCents;
	}
	const frameRange = (f: number): [number, number] => [
		Math.max(0, Math.min(cents.length, Math.round(startFrame[f]))),
		Math.max(0, Math.min(cents.length, Math.round(endFrame[f]))),
	];

	// ── Question rise on the last spoken mora (top-up only) ──
	if (question && questionRiseCents > 0) {
		let last = -1;
		for (let f = count - 1; f >= 0; f--) {
			if (!features[f].pause) {
				last = f;
				break;
			}
		}
		if (last >= 0) {
			const [from, to] = frameRange(last);
			if (to > from) {
				const existing = cents[to - 1] - cents[from];
				const shortfall = questionRiseCents - existing;
				if (shortfall > 0) {
					// Hold the first quarter, then add the missing rise; keep the peak
					// through whatever follows (trailing pause / release).
					for (let frame = from; frame < cents.length; frame++) {
						const t = (frame - from) / (to - from);
						cents[frame] += shortfall * smoothstep((t - 0.25) / 0.75);
					}
				}
			}
		}
	}

	// ── Per-mora gain: pitch-coupled loudness × devoicing ──
	const moraGains: number[] = new Array(features.length).fill(1);
	for (let f = 0; f < count; f++) {
		if (features[f].pause) continue;
		let gainDb = 0;
		if (energyDbPerSemitone !== 0) {
			const [from, to] = frameRange(f);
			if (to > from) {
				let sum = 0;
				for (let frame = from; frame < to; frame++) sum += cents[frame];
				gainDb += (sum / (to - from) / 100) * energyDbPerSemitone;
			}
		}
		let gain = 10 ** (gainDb / 20);
		if (prosody.devoiced[f]) gain *= devoicedGain;
		moraGains[f] = Math.min(maxGain, Math.max(minGain, gain));
	}

	return {
		...prosody,
		moraDurationsMs: durations,
		durationMs,
		pitchCurve: { frame_ms: frameMs, cents },
		moraGains,
	};
}
