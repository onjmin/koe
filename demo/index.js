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
      if (audioFormat === 65534 && size >= 40) {
        audioFormat = view.getUint16(pos + 24, true);
      }
    } else if (id === "data") {
      dataOffset = pos;
      dataLength = Math.min(size, view.byteLength - pos);
      break;
    }
    pos += size + (size & 1);
  }
  if (!dataOffset) throw new Error("WAV has no data chunk");
  if (!channels || !sampleRate) throw new Error("WAV fmt chunk missing");
  const supported = audioFormat === 3 && bitsPerSample === 32 || audioFormat === 1 && (bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24);
  if (!supported) {
    throw new Error(
      `Unsupported WAV format ${audioFormat} / ${bitsPerSample}-bit (need PCM 8/16/24-bit or IEEE float 32-bit)`
    );
  }
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

// node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/converter/zip.ts
function unzipToFileMap(data) {
  const bytes = new Uint8Array(data);
  const unzipped = unzipSync(bytes);
  const isUtf8ByIndex = readUtf8Flags(bytes);
  const sjisDecoder = new TextDecoder("shift_jis");
  const fileMap = {};
  Object.keys(unzipped).forEach((rawName, i) => {
    const fileBytes = unzipped[rawName];
    const name = isUtf8ByIndex[i] ? rawName : sjisDecoder.decode(Uint8Array.from(rawName, (c) => c.charCodeAt(0)));
    const path = name.replace(/\\/g, "/");
    if (path.endsWith("/")) return;
    fileMap[path] = {
      arrayBuffer: () => Promise.resolve(
        fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength
        )
      )
    };
  });
  return Promise.resolve(fileMap);
}
function readUtf8Flags(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  const maxBack = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (view.getUint32(i, true) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const flags = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdOffset, true) !== 33639248) break;
    const flag = view.getUint16(cdOffset + 8, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    flags.push((flag & 2048) !== 0);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return flags;
}

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
var MAX_PHONEME_SAMPLES = 5242880;
var MAX_JSON_LENGTH = 50 * 1024 * 1024;
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
    return rangeFetch(this.url, start, length);
  }
};
async function rangeFetch(url, start, length) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` },
    credentials: "omit"
    // never leak cookies / auth to a MML-supplied URL
  });
  if (res.status !== 206) {
    throw new Error(
      `.koe fetch failed: expected 206 Partial Content, got ${res.status}`
    );
  }
  return readCapped(res, length);
}
async function readCapped(res, length) {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > length) {
      throw new Error(
        `.koe fetch failed: response exceeds requested ${length} bytes`
      );
    }
    return buf;
  }
  const out = new Uint8Array(length);
  let received = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > length) {
      await reader.cancel();
      throw new Error(
        `.koe fetch failed: response exceeds requested ${length} bytes`
      );
    }
    out.set(value, received);
    received += value.byteLength;
  }
  return received === length ? out.buffer : out.buffer.slice(0, received);
}
function validateJsonLength(jsonLength) {
  if (!Number.isInteger(jsonLength) || jsonLength < 0 || jsonLength > MAX_JSON_LENGTH) {
    throw new Error(`manifest JSON length out of bounds: ${jsonLength}`);
  }
}
function parseManifest(json) {
  const manifest = JSON.parse(new TextDecoder().decode(json));
  if (!manifest || typeof manifest !== "object" || typeof manifest.phonemes !== "object" || manifest.phonemes === null) {
    throw new Error("invalid manifest: missing phonemes table");
  }
  return manifest;
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
    try {
      if (typeof koe === "string") {
        if (/^blob:/i.test(koe)) {
          const res = await fetch(koe);
          if (!res.ok) {
            throw new Error(`blob: URL fetch failed: ${res.status}`);
          }
          return await _VoiceBank.fromBlob(await res.blob());
        }
        if (!/^https?:/i.test(koe)) {
          throw new Error(`unsupported URL protocol: ${koe}`);
        }
        const header = await rangeFetch(koe, 0, 8);
        const { jsonLength } = parseKoeHeader(header);
        validateJsonLength(jsonLength);
        const json = await rangeFetch(koe, 8, jsonLength);
        const manifest = parseManifest(json);
        return new _VoiceBank(
          manifest,
          new RangeVoiceSource(koe, pcmBase(jsonLength))
        );
      }
      return await _VoiceBank.fromBlob(koe);
    } catch (error) {
      throw new Error(
        `Failed to load .koe voice bank: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  static async fromBlob(koe) {
    const header = await koe.slice(0, 8).arrayBuffer();
    const { jsonLength } = parseKoeHeader(header);
    validateJsonLength(jsonLength);
    const json = await koe.slice(8, 8 + jsonLength).arrayBuffer();
    const manifest = parseManifest(json);
    return new _VoiceBank(
      manifest,
      new BlobVoiceSource(koe, pcmBase(jsonLength))
    );
  }
  /** True if the bank contains a phoneme under this alias. */
  has(phoneme) {
    return Object.hasOwn(this.manifest.phonemes, phoneme);
  }
  /**
   * Raw Int16 PCM bytes (48 kHz / mono) for a phoneme, or null if unknown.
   * The returned ArrayBuffer is freshly allocated and safe to transfer to a
   * worker / AudioWorklet.
   */
  async readPcmBytes(phoneme) {
    if (!Object.hasOwn(this.manifest.phonemes, phoneme)) return null;
    const entry = this.manifest.phonemes[phoneme];
    if (!Number.isInteger(entry.offset) || !Number.isInteger(entry.length) || entry.offset < 0 || entry.length < 0 || entry.length > MAX_PHONEME_SAMPLES) {
      throw new Error(`manifest entry out of bounds for phoneme: ${phoneme}`);
    }
    return this.source.readBytes(entry.offset, entry.length * 2);
  }
  /**
   * A phoneme's PCM as a Float64Array normalised to [-1, 1], or null if unknown.
   * Intended for external analysis / resynthesis such as the WORLD vocoder.
   */
  async getPcm(phoneme) {
    const buf = await this.readPcmBytes(phoneme);
    if (!buf) return null;
    const int16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
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
    this.node?.disconnect();
    this.node = null;
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
      if (!buf || !this.node) return;
      this.node.port.postMessage({ type: "phoneme", name, buffer: buf }, [
        buf
      ]);
      this.delivered.add(name);
    }).finally(() => {
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
   * Tear down the worklet node and close the AudioContext, releasing the audio
   * hardware. The engine cannot be reused afterwards — create a new one.
   */
  async dispose() {
    this.node?.disconnect();
    this.node = null;
    this.bank = null;
    this.delivered.clear();
    this.pending.clear();
    if (this.ctx.state !== "closed") await this.ctx.close();
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
    const audio = outLen > 0 && yPtr ? new Float32Array(WL.HEAPF32.buffer, yPtr, outLen).slice() : null;
    if (yPtr) WL._free(yPtr);
    WL._free(yPtrPtr);
    WL._PhraseSynthDelete(ps);
    return audio;
  }
};
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
  trimToOto,
  unzipToFileMap
};
//# sourceMappingURL=index.js.map