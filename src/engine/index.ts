import type { Manifest, NoteEvent } from '../types.js';
import { parseKoeHeader, pcmBase } from '../koe.js';

export type { NoteEvent };

export interface KoeEngineOptions {
  /** URL to koe-worklet.js. Defaults to './koe-worklet.js'. */
  workletUrl?: string;
}

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
  constructor(private blob: Blob, private base: number) {}
  readBytes(offset: number, length: number): Promise<ArrayBuffer> {
    const start = this.base + offset;
    return this.blob.slice(start, start + length).arrayBuffer();
  }
}

class RangeVoiceSource implements VoiceSource {
  constructor(private url: string, private base: number) {}
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
 * Main-thread API for the koe concatenative synthesis engine.
 *
 * Loads a single .koe archive. The full voice bank is never held in memory:
 * phonemes are fetched on demand (Blob slice or HTTP Range) and cached in the
 * audio thread.
 *
 *   const engine = new KoeEngine();
 *   await engine.load(koeBlobOrUrl);
 *   await engine.play([{ phoneme: 'a', pitch: 440, duration: 48000 }]);
 */
export class KoeEngine {
  private ctx: AudioContext;
  private workletUrl: string;
  private node: AudioWorkletNode | null = null;
  private source: VoiceSource | null = null;
  private _manifest: Manifest | null = null;
  private delivered = new Set<string>();
  private pending = new Map<string, Promise<void>>();

  constructor(options: KoeEngineOptions = {}) {
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.workletUrl = options.workletUrl ?? './koe-worklet.js';
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  get manifest(): Manifest | null {
    return this._manifest;
  }

  /**
   * Register the worklet and bind a .koe voice bank.
   * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
   */
  async load(koe: Blob | string): Promise<void> {
    await this.ctx.audioWorklet.addModule(this.workletUrl);

    let manifest: Manifest;
    let base: number;

    if (typeof koe === 'string') {
      const header = await rangeFetch(koe, 0, 8);
      const { jsonLength } = parseKoeHeader(header);
      const json = await rangeFetch(koe, 8, jsonLength);
      manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
      base = pcmBase(jsonLength);
      this.source = new RangeVoiceSource(koe, base);
    } else {
      const header = await koe.slice(0, 8).arrayBuffer();
      const { jsonLength } = parseKoeHeader(header);
      const json = await koe.slice(8, 8 + jsonLength).arrayBuffer();
      manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
      base = pcmBase(jsonLength);
      this.source = new BlobVoiceSource(koe, base);
    }

    this._manifest = manifest;
    this.delivered.clear();
    this.pending.clear();

    this.node = new AudioWorkletNode(this.ctx, 'koe-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.postMessage({ type: 'init', manifest });
    this.node.connect(this.ctx.destination);

    console.log('[koe] ready —', Object.keys(manifest.phonemes).length, 'phonemes (on-demand)');
  }

  /** Fetch one phoneme's PCM and deliver it to the worklet (deduped, cached). */
  private ensurePhoneme(name: string): Promise<void> {
    if (this.delivered.has(name)) return Promise.resolve();
    const existing = this.pending.get(name);
    if (existing) return existing;

    const entry = this._manifest?.phonemes[name];
    if (!entry || !this.source || !this.node) return Promise.resolve();

    const byteLength = entry.length * 2; // Int16 = 2 bytes/sample
    const load = this.source.readBytes(entry.offset, byteLength).then(buf => {
      this.node!.port.postMessage({ type: 'phoneme', name, buffer: buf }, [buf]);
      this.delivered.add(name);
      this.pending.delete(name);
    });

    this.pending.set(name, load);
    return load;
  }

  /** Stop current playback, preload the phonemes for `notes`, then queue them. */
  async play(notes: NoteEvent[]): Promise<void> {
    if (!this.node) throw new Error('KoeEngine: call load() before play()');
    this.node.port.postMessage({ type: 'stop' });
    const names = [...new Set(notes.map(n => n.phoneme))].filter(Boolean);
    await Promise.all(names.map(n => this.ensurePhoneme(n)));
    this.node.port.postMessage({ type: 'play', notes });
  }

  /** Stop playback and clear the queue. */
  stop(): void {
    this.node?.port.postMessage({ type: 'stop' });
  }

  /** Resume the AudioContext if suspended (e.g. after autoplay block). */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /**
   * Read a phoneme's raw PCM and return it as a Float64Array normalised to [-1, 1].
   * Intended for external analysis such as WORLD vocoder.
   */
  async getPcm(phoneme: string): Promise<Float64Array | null> {
    const entry = this._manifest?.phonemes[phoneme];
    if (!entry || !this.source) return null;
    const buf = await this.source.readBytes(entry.offset, entry.length * 2);
    const int16 = new Int16Array(buf);
    const f64 = new Float64Array(int16.length);
    for (let i = 0; i < int16.length; i++) f64[i] = int16[i] / 32768;
    return f64;
  }
}
