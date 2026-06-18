import type { Manifest, PhonemeEntry } from '../types.js';
import type { OtoEntry } from './parse-oto.js';
import { detectF0 } from './pitch.js';

const TARGET_RATE = 48000;

function msToSamples(ms: number): number {
  return Math.round((ms / 1000) * TARGET_RATE);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface PackInput {
  oto: OtoEntry;
  /** Full normalized PCM of the source WAV (48kHz / 16bit / mono) */
  pcm: Int16Array;
  /** Known recorded pitch in Hz (e.g. from the .frq file). 0/undefined → auto-detect. */
  recordedPitch?: number;
}

export interface PackOutput {
  manifest: Manifest;
  /** Raw PCM blob — Int16 / 48kHz / mono */
  bin: ArrayBuffer;
}

export interface TrimmedPhoneme {
  /** PCM trimmed to the oto region [offset, cutoff] */
  pcm: Int16Array;
  /** Manifest params relative to the trimmed start (sample 0 = oto offset) */
  entry: Omit<PhonemeEntry, 'offset'>;
}

/**
 * Cut the full WAV PCM down to its usable oto region and recompute parameters
 * relative to the trimmed start.
 *
 * UTAU oto.ini values are all in ms and measured from `offset` (the left blank),
 * except `cutoff` (right blank):
 *   - cutoff >= 0 : measured from the END of the file
 *   - cutoff <  0 : region length from offset = |cutoff|
 *
 * After trimming, sample 0 == oto offset, so pre/overlap/consonant carry over
 * unchanged (just converted to samples), and the slice length is the region end.
 */
export function trimToOto(pcm: Int16Array, oto: OtoEntry, recordedPitch = 0): TrimmedPhoneme {
  const full = pcm.length;

  const start = clamp(msToSamples(oto.offset), 0, full);
  const end = oto.cutoff < 0
    ? clamp(start + msToSamples(-oto.cutoff), start, full)
    : clamp(full - msToSamples(oto.cutoff), start, full);

  const slice = pcm.subarray(start, end);
  const length = slice.length;

  const pre = clamp(msToSamples(oto.pre), 0, length);
  const overlap = clamp(msToSamples(oto.overlap), 0, length);
  const consonant = clamp(msToSamples(oto.consonant), 0, length);

  // Prefer the known recorded pitch (from the .frq file or alias suffix); only
  // fall back to autocorrelation on the sustained vowel when none is available.
  const pitch = recordedPitch > 0
    ? recordedPitch
    : detectF0(slice, Math.min(Math.max(pre, consonant), Math.max(0, length - 1)), length);

  return {
    pcm: slice,
    entry: { length, pre, overlap, consonant, pitch },
  };
}

/**
 * Pack normalized PCM phonemes into voice.bin + manifest.json.
 * Each phoneme is trimmed to its oto region first.
 * Duplicate aliases are silently overwritten by the later entry.
 */
export function pack(inputs: PackInput[], referencePitch = 220): PackOutput {
  const phonemes: Record<string, PhonemeEntry> = {};
  const chunks: Int16Array[] = [];
  let byteOffset = 0;

  for (const { oto, pcm, recordedPitch } of inputs) {
    const { pcm: slice, entry } = trimToOto(pcm, oto, recordedPitch);
    if (slice.length === 0) continue;

    phonemes[oto.alias] = { offset: byteOffset, ...entry };
    byteOffset += slice.byteLength;
    chunks.push(slice);
  }

  const bin = new ArrayBuffer(byteOffset);
  const view = new Uint8Array(bin);
  let pos = 0;
  for (const chunk of chunks) {
    view.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), pos);
    pos += chunk.byteLength;
  }

  const manifest: Manifest = {
    sampleRate: 48000,
    referencePitch,
    phonemes,
  };

  return { manifest, bin };
}
