import type { Manifest } from '../types.js';
import { parseKoeHeader, pcmBase } from '../koe.js';

/**
 * Supplies raw bytes from the PCM section of a .koe archive on demand.
 *  - BlobVoiceSource:  slices an in-memory Blob / File (no full-buffer copy)
 *  - RangeVoiceSource: HTTP Range requests against a URL (mobile-friendly)
 * `base` is the byte offset where PCM data starts (8 + jsonLength).
 */
interface VoiceSource {
  readBytes(offset: number, length: number): Promise<ArrayBuffer>;
}

class BlobVoiceSource implements VoiceSource {
  constructor(
    private blob: Blob,
    private base: number,
  ) {}
  readBytes(offset: number, length: number): Promise<ArrayBuffer> {
    const start = this.base + offset;
    return this.blob.slice(start, start + length).arrayBuffer();
  }
}

class RangeVoiceSource implements VoiceSource {
  constructor(
    private url: string,
    private base: number,
  ) {}
  async readBytes(offset: number, length: number): Promise<ArrayBuffer> {
    const start = this.base + offset;
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${start + length - 1}` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`.koe range request failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }
}

async function rangeFetch(url: string, start: number, length: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  if (!res.ok && res.status !== 206) throw new Error(`.koe fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Read-only access to a .koe voice bank: its manifest plus per-phoneme PCM,
 * fetched on demand (Blob slice or HTTP Range). The full bank is never held in
 * memory.
 *
 * Pure data — no AudioContext, no AudioWorklet, no DOM. Use this when you only
 * need the source samples (e.g. to feed the {@link Worldline} renderer or any
 * other vocoder). {@link KoeEngine} builds its concatenative playback on top of
 * this same class.
 *
 *   const bank = await VoiceBank.load(koeBlobOrUrl);
 *   const pcm  = await bank.getPcm('a');   // Float64 [-1, 1]
 */
export class VoiceBank {
  private constructor(
    /** The voice bank manifest (sample rate, reference pitch, phoneme table). */
    readonly manifest: Manifest,
    private source: VoiceSource,
  ) {}

  /**
   * Parse a .koe archive header + manifest and bind a lazy PCM source.
   * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
   */
  static async load(koe: Blob | string): Promise<VoiceBank> {
    if (typeof koe === 'string') {
      const header = await rangeFetch(koe, 0, 8);
      const { jsonLength } = parseKoeHeader(header);
      const json = await rangeFetch(koe, 8, jsonLength);
      const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
      return new VoiceBank(manifest, new RangeVoiceSource(koe, pcmBase(jsonLength)));
    }
    const header = await koe.slice(0, 8).arrayBuffer();
    const { jsonLength } = parseKoeHeader(header);
    const json = await koe.slice(8, 8 + jsonLength).arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
    return new VoiceBank(manifest, new BlobVoiceSource(koe, pcmBase(jsonLength)));
  }

  /** True if the bank contains a phoneme under this alias. */
  has(phoneme: string): boolean {
    return this.manifest.phonemes[phoneme] !== undefined;
  }

  /**
   * Raw Int16 PCM bytes (48 kHz / mono) for a phoneme, or null if unknown.
   * The returned ArrayBuffer is freshly allocated and safe to transfer to a
   * worker / AudioWorklet.
   */
  async readPcmBytes(phoneme: string): Promise<ArrayBuffer | null> {
    const entry = this.manifest.phonemes[phoneme];
    if (!entry) return null;
    return this.source.readBytes(entry.offset, entry.length * 2); // Int16 = 2 bytes/sample
  }

  /**
   * A phoneme's PCM as a Float64Array normalised to [-1, 1], or null if unknown.
   * Intended for external analysis / resynthesis such as the WORLD vocoder.
   */
  async getPcm(phoneme: string): Promise<Float64Array | null> {
    const buf = await this.readPcmBytes(phoneme);
    if (!buf) return null;
    const int16 = new Int16Array(buf);
    const f64 = new Float64Array(int16.length);
    for (let i = 0; i < int16.length; i++) f64[i] = int16[i] / 32768;
    return f64;
  }
}
