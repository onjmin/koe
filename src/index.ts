// Engine (browser)

export { frqFileName, parseFrqAverageF0 } from "./converter/frq.js";
export type {
	PackInput,
	PackOutput,
	TrimmedPhoneme,
} from "./converter/pack.js";
export { pack, trimToOto } from "./converter/pack.js";
export type { OtoEntry } from "./converter/parse-oto.js";
// Converter utilities (browser + Node.js)
export { parseOto } from "./converter/parse-oto.js";
export {
	detectF0,
	noteNameToHz,
	pitchFromAliasSuffix,
} from "./converter/pitch.js";
export type { WavData } from "./converter/wav.js";
export {
	normalizePcm,
	parseWav,
	resample,
	toInt16,
	toMono,
} from "./converter/wav.js";
export type { KoeEngineOptions, NoteEvent } from "./engine/index.js";
export { KoeEngine } from "./engine/index.js";
// Voice bank — DOM/AudioContext-free PCM access (manifest + getPcm)
export { VoiceBank } from "./engine/voice-bank.js";
export type {
	RenderNoteParams,
	WorldlineLoadOptions,
} from "./engine/worldline.js";
// worldline — WORLD-vocoder note renderer (WASM)
export {
	leadInFromEntry,
	MIN_WORLDLINE_SAMPLES,
	samplesToMs,
	WORLDLINE_SAMPLE_RATE,
	Worldline,
} from "./engine/worldline.js";

// .koe archive format
export { packKoe, parseKoeHeader, pcmBase } from "./koe.js";

// Shared types
export type { Manifest, PhonemeEntry } from "./types.js";
