// src/koe.ts
var MAGIC = 1263486208;
function packKoe(manifest, pcmParts) {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, json.byteLength, true);
  return new Blob([header, json, ...pcmParts]);
}
function parseKoeHeader(headerBytes) {
  const view = new DataView(headerBytes);
  if (view.byteLength < 8 || view.getUint32(0, false) !== MAGIC) {
    throw new Error("Not a .koe file (bad magic)");
  }
  return { jsonLength: view.getUint32(4, true) };
}
var pcmBase = (jsonLength) => 8 + jsonLength;

// src/engine/voice-bank.ts
var BlobVoiceSource = class {
  constructor(blob, base) {
    this.blob = blob;
    this.base = base;
  }
  blob;
  base;
  readBytes(offset, length) {
    const start = this.base + offset;
    return this.blob.slice(start, start + length).arrayBuffer();
  }
};
var RangeVoiceSource = class {
  constructor(url, base) {
    this.url = url;
    this.base = base;
  }
  url;
  base;
  async readBytes(offset, length) {
    const start = this.base + offset;
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${start + length - 1}` }
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`.koe range request failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }
};
async function rangeFetch(url, start, length) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` }
  });
  if (!res.ok && res.status !== 206)
    throw new Error(`.koe fetch failed: ${res.status}`);
  return res.arrayBuffer();
}
var VoiceBank = class _VoiceBank {
  constructor(manifest, source) {
    this.manifest = manifest;
    this.source = source;
  }
  manifest;
  source;
  /**
   * Parse a .koe archive header + manifest and bind a lazy PCM source.
   * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
   */
  static async load(koe) {
    if (typeof koe === "string") {
      const header2 = await rangeFetch(koe, 0, 8);
      const { jsonLength: jsonLength2 } = parseKoeHeader(header2);
      const json2 = await rangeFetch(koe, 8, jsonLength2);
      const manifest2 = JSON.parse(new TextDecoder().decode(json2));
      return new _VoiceBank(
        manifest2,
        new RangeVoiceSource(koe, pcmBase(jsonLength2))
      );
    }
    const header = await koe.slice(0, 8).arrayBuffer();
    const { jsonLength } = parseKoeHeader(header);
    const json = await koe.slice(8, 8 + jsonLength).arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(json));
    return new _VoiceBank(
      manifest,
      new BlobVoiceSource(koe, pcmBase(jsonLength))
    );
  }
  /** True if the bank contains a phoneme under this alias. */
  has(phoneme) {
    return this.manifest.phonemes[phoneme] !== void 0;
  }
  /**
   * Raw Int16 PCM bytes (48 kHz / mono) for a phoneme, or null if unknown.
   * The returned ArrayBuffer is freshly allocated and safe to transfer to a
   * worker / AudioWorklet.
   */
  async readPcmBytes(phoneme) {
    const entry = this.manifest.phonemes[phoneme];
    if (!entry) return null;
    return this.source.readBytes(entry.offset, entry.length * 2);
  }
  /**
   * A phoneme's PCM as a Float64Array normalised to [-1, 1], or null if unknown.
   * Intended for external analysis / resynthesis such as the WORLD vocoder.
   */
  async getPcm(phoneme) {
    const buf = await this.readPcmBytes(phoneme);
    if (!buf) return null;
    const int16 = new Int16Array(buf);
    const f64 = new Float64Array(int16.length);
    for (let i = 0; i < int16.length; i++) f64[i] = int16[i] / 32768;
    return f64;
  }
};

// src/engine/index.ts
var KoeEngine = class {
  ctx;
  workletUrl;
  node = null;
  bank = null;
  delivered = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.ctx = new AudioContext({ sampleRate: 48e3 });
    this.workletUrl = options.workletUrl ?? "./koe-worklet.js";
  }
  get audioContext() {
    return this.ctx;
  }
  get manifest() {
    return this.bank?.manifest ?? null;
  }
  /** The underlying voice bank (manifest + on-demand PCM), or null before load(). */
  get voiceBank() {
    return this.bank;
  }
  /**
   * Register the worklet and bind a .koe voice bank.
   * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
   */
  async load(koe) {
    await this.ctx.audioWorklet.addModule(this.workletUrl);
    this.bank = await VoiceBank.load(koe);
    this.delivered.clear();
    this.pending.clear();
    this.node = new AudioWorkletNode(this.ctx, "koe-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    this.node.port.postMessage({ type: "init", manifest: this.bank.manifest });
    this.node.connect(this.ctx.destination);
    console.log(
      "[koe] ready \u2014",
      Object.keys(this.bank.manifest.phonemes).length,
      "phonemes (on-demand)"
    );
  }
  /** Fetch one phoneme's PCM and deliver it to the worklet (deduped, cached). */
  ensurePhoneme(name) {
    if (this.delivered.has(name)) return Promise.resolve();
    const existing = this.pending.get(name);
    if (existing) return existing;
    if (!this.bank || !this.node) return Promise.resolve();
    const load = this.bank.readPcmBytes(name).then((buf) => {
      if (!buf) return;
      this.node.port.postMessage({ type: "phoneme", name, buffer: buf }, [
        buf
      ]);
      this.delivered.add(name);
      this.pending.delete(name);
    });
    this.pending.set(name, load);
    return load;
  }
  /** Stop current playback, preload the phonemes for `notes`, then queue them. */
  async play(notes) {
    if (!this.node) throw new Error("KoeEngine: call load() before play()");
    this.node.port.postMessage({ type: "stop" });
    const names = [...new Set(notes.map((n) => n.phoneme))].filter(Boolean);
    await Promise.all(names.map((n) => this.ensurePhoneme(n)));
    this.node.port.postMessage({ type: "play", notes });
  }
  /** Stop playback and clear the queue. */
  stop() {
    this.node?.port.postMessage({ type: "stop" });
  }
  /** Resume the AudioContext if suspended (e.g. after autoplay block). */
  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }
  /**
   * Read a phoneme's raw PCM and return it as a Float64Array normalised to
   * [-1, 1]. Convenience that forwards to the underlying {@link VoiceBank}.
   * Intended for external analysis such as the WORLD vocoder.
   */
  async getPcm(phoneme) {
    return this.bank?.getPcm(phoneme) ?? null;
  }
};

// src/engine/worldline.ts
var WORLDLINE_SAMPLE_RATE = 48e3;
var MIN_WORLDLINE_SAMPLES = 4096;
var SYNTH_REQ_SIZE = 120;
var WL_FRAME_MS = 10;
var samplesToMs = (samples) => samples / WORLDLINE_SAMPLE_RATE * 1e3;
function leadInFromEntry(entry) {
  return {
    preMs: samplesToMs(entry.pre || 0),
    consonantMs: samplesToMs(entry.consonant || 0)
  };
}
var moduleCache = /* @__PURE__ */ new Map();
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-koe-worldline="${src}"]`
    );
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.koeWorldline = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`worldline: failed to load ${src}`));
    document.head.appendChild(s);
  });
}
function loadWasm(scriptUrl) {
  const cached = moduleCache.get(scriptUrl);
  if (cached) return cached;
  const baseUrl = scriptUrl.slice(0, scriptUrl.lastIndexOf("/") + 1);
  const instantiate = () => {
    const factory = globalThis.WorldlineModule;
    if (!factory)
      throw new Error(
        "worldline: WorldlineModule global was not defined by the script"
      );
    return factory({ locateFile: (f) => baseUrl + f });
  };
  let promise;
  if (typeof document !== "undefined") {
    promise = injectScript(scriptUrl).then(instantiate);
  } else if (typeof globalThis.importScripts === "function") {
    promise = Promise.resolve().then(() => {
      globalThis.importScripts(scriptUrl);
      return instantiate();
    });
  } else {
    return Promise.reject(
      new Error(
        "Worldline.load requires a DOM or a classic Web Worker (importScripts) to load worldline.js"
      )
    );
  }
  moduleCache.set(scriptUrl, promise);
  return promise;
}
var Worldline = class _Worldline {
  constructor(wasm) {
    this.wasm = wasm;
  }
  wasm;
  sampleRate = WORLDLINE_SAMPLE_RATE;
  /**
   * Load + instantiate the worldline WASM module (deduped per scriptUrl).
   *
   * Works on the main thread (loads via `<script>`) and inside a classic Web
   * Worker (loads via `importScripts`), so the heavy synthesis can run
   * off-thread. The matching `worldline.wasm` is fetched next to scriptUrl.
   */
  static async load(options) {
    return new _Worldline(await loadWasm(options.scriptUrl));
  }
  /**
   * Render one note to Float32 PCM at 48 kHz.
   *
   * The output buffer is laid out as [lead-in/consonant ≈ preMs][vowel ≈
   * durationMs], rendered from sample offset 0 (no leading silence). The vowel
   * onset (the "beat") sits at ≈ preMs into the buffer, so a sequencer should
   * place the buffer at `beatTime − preMs` and may trim/crossfade the lead-in.
   *
   * No internal crossfade is applied — apply fades externally.
   *
   * @returns Float32 PCM, or null when `pcm` is shorter than
   *          {@link MIN_WORLDLINE_SAMPLES} (too short for stable F0 analysis).
   */
  renderNote(params) {
    const { pcm, pitch, durationMs, preMs, consonantMs, tempo = 120 } = params;
    if (!pcm || pcm.length < MIN_WORLDLINE_SAMPLES) return null;
    const WL = this.wasm;
    const FS = WORLDLINE_SAMPLE_RATE;
    const midiNote = Math.round(69 + 12 * Math.log2(pitch / 440));
    const posMs = 0;
    const reqLen = preMs + durationMs;
    const cutMs = WL_FRAME_MS * 2;
    const ps = WL._PhraseSynthNew();
    if (!ps) return null;
    const reqPtr = WL._malloc(SYNTH_REQ_SIZE);
    if (!reqPtr) {
      WL._PhraseSynthDelete(ps);
      return null;
    }
    const samplePtr = WL._malloc(pcm.length * 8);
    if (!samplePtr) {
      WL._free(reqPtr);
      WL._PhraseSynthDelete(ps);
      return null;
    }
    WL.HEAPF64.set(pcm, samplePtr >> 3);
    const sv = (off, val, type) => WL.setValue(reqPtr + off, val, type);
    sv(0, FS, "i32");
    sv(4, pcm.length, "i32");
    sv(8, samplePtr, "*");
    sv(12, 0, "i32");
    sv(16, 0, "*");
    sv(20, midiNote, "i32");
    sv(24, 100, "double");
    sv(32, 0, "double");
    sv(40, reqLen, "double");
    sv(48, consonantMs, "double");
    sv(56, cutMs, "double");
    sv(64, 100, "double");
    sv(72, 0, "double");
    sv(80, tempo, "double");
    sv(88, 0, "i32");
    sv(92, 0, "*");
    sv(96, 0, "i32");
    sv(100, 0, "i32");
    sv(104, 100, "i32");
    sv(108, 0, "i32");
    sv(112, 0, "i32");
    sv(116, 100, "i32");
    WL._PhraseSynthAddRequest(ps, reqPtr, posMs, 0, reqLen, 0, 0, 0);
    WL._free(samplePtr);
    WL._free(reqPtr);
    const totalMs = posMs + reqLen + WL_FRAME_MS * 2;
    const nFrames = Math.ceil(totalMs / WL_FRAME_MS) + 4;
    const f0Arr = new Float64Array(nFrames).fill(pitch);
    const gArr = new Float64Array(nFrames).fill(0.5);
    const tArr = new Float64Array(nFrames).fill(0.5);
    const bArr = new Float64Array(nFrames).fill(0.5);
    const vArr = new Float64Array(nFrames).fill(1);
    const f0Ptr = WL._malloc(nFrames * 8);
    const gPtr = WL._malloc(nFrames * 8);
    const tPtr = WL._malloc(nFrames * 8);
    const bPtr = WL._malloc(nFrames * 8);
    const vPtr = WL._malloc(nFrames * 8);
    if (!f0Ptr || !gPtr || !tPtr || !bPtr || !vPtr) {
      if (f0Ptr) WL._free(f0Ptr);
      if (gPtr) WL._free(gPtr);
      if (tPtr) WL._free(tPtr);
      if (bPtr) WL._free(bPtr);
      if (vPtr) WL._free(vPtr);
      WL._PhraseSynthDelete(ps);
      return null;
    }
    WL.HEAPF64.set(f0Arr, f0Ptr >> 3);
    WL.HEAPF64.set(gArr, gPtr >> 3);
    WL.HEAPF64.set(tArr, tPtr >> 3);
    WL.HEAPF64.set(bArr, bPtr >> 3);
    WL.HEAPF64.set(vArr, vPtr >> 3);
    WL._PhraseSynthSetCurves(
      ps,
      f0Ptr,
      gPtr,
      tPtr,
      bPtr,
      vPtr,
      nFrames,
      WL_FRAME_MS
    );
    WL._free(f0Ptr);
    WL._free(gPtr);
    WL._free(tPtr);
    WL._free(bPtr);
    WL._free(vPtr);
    const yPtrPtr = WL._malloc(4);
    if (!yPtrPtr) {
      WL._PhraseSynthDelete(ps);
      return null;
    }
    const outLen = WL._PhraseSynthSynth(ps, yPtrPtr, 0);
    const yPtr = WL.getValue(yPtrPtr, "*");
    const audio = outLen > 0 ? new Float32Array(WL.HEAPF32.buffer, yPtr, outLen).slice() : null;
    WL._free(yPtrPtr);
    WL._PhraseSynthDelete(ps);
    return audio;
  }
};

// src/converter/parse-oto.ts
function parseOto(content) {
  const entries = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const wav = line.slice(0, eq).trim();
    const parts = line.slice(eq + 1).split(",");
    if (parts.length < 6) continue;
    const [alias, offsetStr, consonantStr, cutoffStr, preStr, overlapStr] = parts;
    const aliasStr = alias.trim() || wav.replace(/\.[^.]+$/, "");
    const entry = {
      wav,
      alias: aliasStr,
      offset: parseFloat(offsetStr) || 0,
      consonant: parseFloat(consonantStr) || 0,
      cutoff: parseFloat(cutoffStr) || 0,
      pre: parseFloat(preStr) || 0,
      overlap: parseFloat(overlapStr) || 0
    };
    if (!entry.alias) continue;
    entries.push(entry);
  }
  return entries;
}

// src/converter/wav.ts
function parseWav(buf) {
  const view = new DataView(buf);
  const riff = readFourCC(view, 0);
  if (riff !== "RIFF") throw new Error(`Not a RIFF file (got "${riff}")`);
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  let dataOffset = 0;
  let dataLength = 0;
  let pos = 12;
  while (pos < view.byteLength - 8) {
    const id = readFourCC(view, pos);
    const size = view.getUint32(pos + 4, true);
    pos += 8;
    if (id === "fmt ") {
      audioFormat = view.getUint16(pos, true);
      channels = view.getUint16(pos + 2, true);
      sampleRate = view.getUint32(pos + 4, true);
      bitsPerSample = view.getUint16(pos + 14, true);
    } else if (id === "data") {
      dataOffset = pos;
      dataLength = size;
      break;
    }
    pos += size + (size & 1);
  }
  if (!dataOffset) throw new Error("WAV has no data chunk");
  if (!channels || !sampleRate) throw new Error("WAV fmt chunk missing");
  const bytesPerSample = bitsPerSample >> 3;
  const totalSamples = Math.floor(dataLength / bytesPerSample);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const p = dataOffset + i * bytesPerSample;
    if (audioFormat === 3) {
      samples[i] = view.getFloat32(p, true);
    } else if (bitsPerSample === 8) {
      samples[i] = (view.getUint8(p) - 128) / 128;
    } else if (bitsPerSample === 16) {
      samples[i] = view.getInt16(p, true) / 32768;
    } else if (bitsPerSample === 24) {
      const lo = view.getUint8(p) | view.getUint8(p + 1) << 8;
      let hi = view.getUint8(p + 2);
      if (hi & 128) hi = hi | 4294967040;
      samples[i] = (hi << 16 | lo) / 8388608;
    }
  }
  return { sampleRate, channels, samples };
}
function toMono(wav) {
  if (wav.channels === 1) return wav;
  const len = wav.samples.length / wav.channels;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++)
      sum += wav.samples[i * wav.channels + c];
    out[i] = sum / wav.channels;
  }
  return { sampleRate: wav.sampleRate, channels: 1, samples: out };
}
function resample(wav, targetRate) {
  if (wav.sampleRate === targetRate) return wav;
  const ratio = wav.sampleRate / targetRate;
  const outLen = Math.floor(wav.samples.length / ratio);
  const out = new Float32Array(outLen);
  const src = wav.samples;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const xi = Math.floor(x);
    const frac = x - xi;
    out[i] = (src[xi] ?? 0) + ((src[xi + 1] ?? 0) - (src[xi] ?? 0)) * frac;
  }
  return { sampleRate: targetRate, channels: 1, samples: out };
}
function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  }
  return out;
}
function normalizePcm(buf) {
  const wav = parseWav(buf);
  const mono = toMono(wav);
  const resampled = resample(mono, 48e3);
  return toInt16(resampled.samples);
}
function readFourCC(view, pos) {
  return String.fromCharCode(
    view.getUint8(pos),
    view.getUint8(pos + 1),
    view.getUint8(pos + 2),
    view.getUint8(pos + 3)
  );
}

// src/converter/pitch.ts
var SAMPLE_RATE = 48e3;
var NAME_SEMITONE = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11
};
function noteNameToHz(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
  if (!m) return null;
  let semi = NAME_SEMITONE[m[1].toLowerCase()];
  if (m[2] === "#") semi++;
  else if (m[2] === "b") semi--;
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
  return 440 * 2 ** ((midi - 69) / 12);
}
function pitchFromAliasSuffix(alias) {
  const m = /_([A-Ga-g][#b]?-?\d+)$/.exec(alias);
  return m ? noteNameToHz(m[1]) : null;
}
function detectF0(pcm, start, end) {
  const DECIM = 4;
  const sr = SAMPLE_RATE / DECIM;
  const minLag = Math.floor(sr / 700);
  const maxLag = Math.floor(sr / 70);
  const outLen = Math.floor((end - start) / DECIM);
  if (outLen < maxLag + 2) return 0;
  const win = Math.min(outLen, 1500);
  const buf = new Float32Array(win);
  let mean = 0;
  for (let i = 0; i < win; i++) {
    let s = 0;
    const base = start + i * DECIM;
    for (let j = 0; j < DECIM; j++) s += pcm[base + j];
    buf[i] = s;
    mean += s;
  }
  mean /= win;
  const sq = new Float64Array(win + 1);
  for (let i = 0; i < win; i++) {
    buf[i] -= mean;
    sq[i + 1] = sq[i] + buf[i] * buf[i];
  }
  if (sq[win] < 1) return 0;
  const norm = (lag) => {
    const n = win - lag;
    let r = 0;
    for (let i = 0; i < n; i++) r += buf[i] * buf[i + lag];
    const e = sq[n] + (sq[lag + n] - sq[lag]);
    return e > 0 ? 2 * r / e : 0;
  };
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = norm(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (bestLag < 1 || best < 0.4) return 0;
  const y0 = norm(bestLag - 1);
  const y1 = best;
  const y2 = norm(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  return sr / (bestLag + shift);
}

// src/converter/pack.ts
var TARGET_RATE = 48e3;
function msToSamples(ms) {
  return Math.round(ms / 1e3 * TARGET_RATE);
}
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function trimToOto(pcm, oto, recordedPitch = 0) {
  const full = pcm.length;
  const start = clamp(msToSamples(oto.offset), 0, full);
  const end = oto.cutoff < 0 ? clamp(start + msToSamples(-oto.cutoff), start, full) : clamp(full - msToSamples(oto.cutoff), start, full);
  const slice = pcm.subarray(start, end);
  const length = slice.length;
  const pre = clamp(msToSamples(oto.pre), 0, length);
  const overlap = clamp(msToSamples(oto.overlap), 0, length);
  const consonant = clamp(msToSamples(oto.consonant), 0, length);
  const pitch = recordedPitch > 0 ? recordedPitch : detectF0(
    slice,
    Math.min(Math.max(pre, consonant), Math.max(0, length - 1)),
    length
  );
  return {
    pcm: slice,
    entry: { length, pre, overlap, consonant, pitch }
  };
}
function pack(inputs, referencePitch = 220) {
  const phonemes = {};
  const chunks = [];
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
    view.set(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      pos
    );
    pos += chunk.byteLength;
  }
  const manifest = {
    sampleRate: 48e3,
    referencePitch,
    phonemes
  };
  return { manifest, bin };
}

// src/converter/frq.ts
function parseFrqAverageF0(buffer) {
  if (buffer.byteLength < 20) return null;
  const view = new DataView(buffer);
  let header = "";
  for (let i = 0; i < 8; i++) header += String.fromCharCode(view.getUint8(i));
  if (header !== "FREQ0003") return null;
  const avg = view.getFloat64(12, true);
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}
function frqFileName(wavName) {
  const dot = wavName.lastIndexOf(".");
  const base = dot >= 0 ? wavName.slice(0, dot) : wavName;
  const ext = dot >= 0 ? wavName.slice(dot + 1) : "wav";
  return `${base}_${ext}.frq`;
}
export {
  KoeEngine,
  MIN_WORLDLINE_SAMPLES,
  VoiceBank,
  WORLDLINE_SAMPLE_RATE,
  Worldline,
  detectF0,
  frqFileName,
  leadInFromEntry,
  normalizePcm,
  noteNameToHz,
  pack,
  packKoe,
  parseFrqAverageF0,
  parseKoeHeader,
  parseOto,
  parseWav,
  pcmBase,
  pitchFromAliasSuffix,
  resample,
  samplesToMs,
  toInt16,
  toMono,
  trimToOto
};
//# sourceMappingURL=index.js.map