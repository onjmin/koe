import type { AlignHtsOptions } from "./hts.js";
import type { ShapeProsodyOptions } from "./prosody_rules.js";
import type { UtauTTSRenderOptions } from "./UtauTTSAdapter.js";

/**
 * Speaking style: the handful of global knobs the pipeline already has,
 * bundled so an application can offer "calm / neutral / lively" (or map an
 * emotion label onto them) without knowing which stage each knob lives in.
 *
 * Nothing here needs assets or compute: `speed` goes to
 * `analyze_prosody(text, speed)`, `intonation` to `alignHtsProsody`,
 * `pauseScale` / `durationContrast` / `pitchShiftCents` to `shapeProsody`,
 * `energyDbPerSemitone` to `renderChunks`. A different HTS voice (tohoku-f01
 * ships happy / sad / angry variants next to neutral) changes the phoneme
 * durations and F0 themselves and composes with these knobs.
 */
export interface SpeakingStyle {
	/** HTS speaking rate; 1 = the voice model's own rate (~7 morae/s for tohoku-f01). */
	speed: number;
	/** F0 excursion scale (`AlignHtsOptions.intonationStrength`). */
	intonation: number;
	/** Baseline pitch shift in cents, added to the whole F0 curve. */
	pitchShiftCents: number;
	/** Multiplier on the punctuation pause minimums (「。」650 / 「、」380 / space 500 ms at 1). */
	pauseScale: number;
	/** Mora-duration contrast expansion around the mean (`ShapeProsodyOptions.durationContrast`). */
	durationContrast: number;
	/** Loudness contour strength in dB per semitone (`UtauTTSRenderOptions.energyDbPerSemitone`). */
	energyDbPerSemitone: number;
}

export type SpeakingStyleName = "neutral" | "calm" | "lively";

/**
 * Presets. `neutral` is the pipeline's defaults; `calm` is a reading /
 * narration pace (slower, longer sentence pauses, gentler dynamics, slightly
 * lower baseline); `lively` is the opposite. Values are starting points meant
 * to be tuned by ear.
 */
export const SPEAKING_STYLES: Record<SpeakingStyleName, SpeakingStyle> = {
	neutral: {
		speed: 1,
		intonation: 1,
		pitchShiftCents: 0,
		pauseScale: 1,
		durationContrast: 1.3,
		energyDbPerSemitone: 0.8,
	},
	calm: {
		speed: 0.9,
		intonation: 0.9,
		pitchShiftCents: -100,
		pauseScale: 1.4,
		durationContrast: 1.2,
		energyDbPerSemitone: 0.6,
	},
	lively: {
		speed: 1.08,
		intonation: 1.3,
		pitchShiftCents: 100,
		pauseScale: 0.85,
		durationContrast: 1.4,
		energyDbPerSemitone: 1,
	},
};

const BASE_PAUSE_MS = { sentence: 650, clause: 380, space: 500 } as const;

/** A preset name, or a preset name plus overrides, or a full/partial style over `neutral`. */
export type SpeakingStyleInput =
	| SpeakingStyleName
	| (Partial<SpeakingStyle> & { preset?: SpeakingStyleName });

/** Resolve a style input to a complete {@link SpeakingStyle}. */
export function resolveSpeakingStyle(
	input: SpeakingStyleInput = "neutral",
): SpeakingStyle {
	if (typeof input === "string") return { ...SPEAKING_STYLES[input] };
	const { preset = "neutral", ...overrides } = input;
	return { ...SPEAKING_STYLES[preset], ...overrides };
}

/** Options for `alignHtsProsody` that follow the style. */
export function styleAlignOptions(style: SpeakingStyle): AlignHtsOptions {
	return { intonationStrength: style.intonation };
}

/** Options for `shapeProsody` that follow the style (merge your own, e.g. `question`, on top). */
export function styleShapeOptions(style: SpeakingStyle): ShapeProsodyOptions {
	return {
		pauseMs: {
			sentence: BASE_PAUSE_MS.sentence * style.pauseScale,
			clause: BASE_PAUSE_MS.clause * style.pauseScale,
			space: BASE_PAUSE_MS.space * style.pauseScale,
		},
		durationContrast: style.durationContrast,
		pitchShiftCents: style.pitchShiftCents,
	};
}

/** Options for `renderChunks` / `synthesizeText` that follow the style. */
export function styleRenderOptions(style: SpeakingStyle): UtauTTSRenderOptions {
	return { energyDbPerSemitone: style.energyDbPerSemitone };
}
