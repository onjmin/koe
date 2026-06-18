export interface WavData {
  sampleRate: number;
  channels: number;
  /** Normalized samples in [-1, 1], interleaved if multi-channel */
  samples: Float32Array;
}

/** Parse a WAV file from an ArrayBuffer. Supports PCM 8/16/24-bit and IEEE float 32-bit. */
export function parseWav(buf: ArrayBuffer): WavData {
  const view = new DataView(buf);

  const riff = readFourCC(view, 0);
  if (riff !== 'RIFF') throw new Error(`Not a RIFF file (got "${riff}")`);

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

    if (id === 'fmt ') {
      audioFormat = view.getUint16(pos, true);
      channels = view.getUint16(pos + 2, true);
      sampleRate = view.getUint32(pos + 4, true);
      bitsPerSample = view.getUint16(pos + 14, true);
    } else if (id === 'data') {
      dataOffset = pos;
      dataLength = size;
      break;
    }

    pos += size + (size & 1);
  }

  if (!dataOffset) throw new Error('WAV has no data chunk');
  if (!channels || !sampleRate) throw new Error('WAV fmt chunk missing');

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
      const lo = view.getUint8(p) | (view.getUint8(p + 1) << 8);
      let hi = view.getUint8(p + 2);
      if (hi & 0x80) hi = hi | 0xffffff00;
      samples[i] = ((hi << 16) | lo) / 8388608;
    }
  }

  return { sampleRate, channels, samples };
}

/** Mix down to mono by averaging all channels. */
export function toMono(wav: WavData): WavData {
  if (wav.channels === 1) return wav;
  const len = wav.samples.length / wav.channels;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) sum += wav.samples[i * wav.channels + c];
    out[i] = sum / wav.channels;
  }
  return { sampleRate: wav.sampleRate, channels: 1, samples: out };
}

/** Linear interpolation resample to targetRate. Expects mono input. */
export function resample(wav: WavData, targetRate: number): WavData {
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

/** Convert Float32 [-1,1] samples to Int16 PCM. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  }
  return out;
}

/** Normalize then convert a WAV to 48kHz/16bit/mono Int16 PCM. */
export function normalizePcm(buf: ArrayBuffer): Int16Array {
  const wav = parseWav(buf);
  const mono = toMono(wav);
  const resampled = resample(mono, 48000);
  return toInt16(resampled.samples);
}

function readFourCC(view: DataView, pos: number): string {
  return String.fromCharCode(
    view.getUint8(pos),
    view.getUint8(pos + 1),
    view.getUint8(pos + 2),
    view.getUint8(pos + 3),
  );
}
