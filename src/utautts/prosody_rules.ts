import type { HtsProsody } from "./hts.js";
import type { FeatureFrame } from "./openjtalk_features.js";

/**
 * Rule-based residuals on top of the HTS prosody (a cut-down Fujisaki-style
 * layer): the statistical model gives the accent shape, these rules add what
 * the HTS voices were not trained for and what a concatenative voice bank
 * lacks on its own.
 *
 *  - question rise: a sentence ending in 「？」 gets at least a minimum rise
 *    on its last mora; Open JTalk's interrogative label flag already makes
 *    tohoku-f01 rise, so this only tops up voices/sentences that do not
 *  - energy envelope: loudness follows pitch (accented morae louder, phrase
 *    ends softer), which a plain unit concatenation renders flat
 *  - devoiced vowels: morae HTS predicted as devoiced (「です」「ます」…) are
 *    attenuated so the voiced sample does not shout a vowel the speaker
 *    would whisper
 *
 * Zero assets, negligible compute; everything is mora-level arithmetic.
 */
export interface ShapeProsodyOptions {
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
	 * Loudness coupling: dB per 100 cents of pitch relative to the speaker
	 * median. 0 disables the energy envelope. Default 0.5 (≈ +2 dB at +400 cent).
	 */
	energyDbPerSemitone?: number;
	/** Linear gain for morae with a devoiced nucleus. Default 0.5 (−6 dB). */
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
		energyDbPerSemitone = 0.5,
		devoicedGain = 0.5,
		minGain = 0.35,
		maxGain = 1.8,
	} = options;
	const { frame_ms: frameMs } = prosody.pitchCurve;
	const cents = prosody.pitchCurve.cents.slice();
	const count = Math.min(features.length, prosody.moraDurationsMs.length);

	// Mora boundaries on the plan time axis, in frames.
	const startFrame: number[] = [];
	const endFrame: number[] = [];
	let cursor = 0;
	for (let f = 0; f < count; f++) {
		startFrame.push(cursor / frameMs);
		cursor += prosody.moraDurationsMs[f];
		endFrame.push(cursor / frameMs);
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
		pitchCurve: { frame_ms: frameMs, cents },
		moraGains,
	};
}
