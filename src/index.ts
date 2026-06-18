// Engine (browser)
export { KoeEngine } from './engine/index.js';
export type { KoeEngineOptions, NoteEvent } from './engine/index.js';

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
