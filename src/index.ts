// Engine (browser)
export { KoeEngine } from './engine/index.js';
export type { KoeEngineOptions, NoteEvent } from './engine/index.js';

// Voice bank — DOM/AudioContext-free PCM access (manifest + getPcm)
export { VoiceBank } from './engine/voice-bank.js';

// worldline — WORLD-vocoder note renderer (WASM)
export { Worldline, leadInFromEntry, samplesToMs, WORLDLINE_SAMPLE_RATE, MIN_WORLDLINE_SAMPLES } from './engine/worldline.js';
export type { WorldlineLoadOptions, RenderNoteParams } from './engine/worldline.js';

// Converter utilities (browser + Node.js)
export { parseOto } from './converter/parse-oto.js';
export type { OtoEntry } from './converter/parse-oto.js';
export { parseWav, toMono, resample, toInt16, normalizePcm } from './converter/wav.js';
export type { WavData } from './converter/wav.js';
export { pack, trimToOto } from './converter/pack.js';
export type { PackInput, PackOutput, TrimmedPhoneme } from './converter/pack.js';
export { detectF0, noteNameToHz, pitchFromAliasSuffix } from './converter/pitch.js';
export { parseFrqAverageF0, frqFileName } from './converter/frq.js';

// .koe archive format
export { packKoe, parseKoeHeader, pcmBase } from './koe.js';

// Shared types
export type { Manifest, PhonemeEntry } from './types.js';
