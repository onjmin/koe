# koe

ブラウザ上でUTAU音源をラグ無しで再生するnpmモジュール。

UTAU の oto.ini で定義された音源を `.koe` アーカイブに変換し、WebAssembly + AudioWorklet でリアルタイム再生・高品質再合成を行う。

- [DEMO](https://onjmin.github.io/koe/demo) koeフォーマット作成もこちらで
- [npm](https://www.npmjs.com/package/@onjmin/koe)

---

## インストール

```bash
npm install @onjmin/koe
# or
pnpm add @onjmin/koe
```

---

## 設計概要

```
UTAU音源 (wav + oto.ini + frq)
        ↓  変換 (pack / koe-convert CLI)
    .koe アーカイブ
    ├── 8byte ヘッダ (magic + JSON長)
    ├── manifest JSON (音素テーブル・ピッチ情報)
    └── PCM バイナリ (Int16 / 48kHz / mono)
        ↓
 VoiceBank  ──── Blob slice / HTTP Range で音素を必要時のみ取得
        ├── KoeEngine  ── AudioWorklet で連接合成・リアルタイム再生
        └── Worldline  ── WORLD ボコーダ (WASM) で高品質ノート合成
```

- **VoiceBank** : `.koe` ファイルの読み取り専用ビュー。AudioContext 不要。音素 PCM をオンデマンドで取得する。
- **KoeEngine** : メインスレッド API。`VoiceBank` の上に AudioWorklet を組み合わせた連接合成エンジン。
- **Worldline** : OpenUtau の worldline WASM を使った高品質ノート合成。PCM を入力して Float32 PCM を返す純粋な合成器。

---

## 使い方

### 1. 音源の変換 (oto.ini → .koe)

CLIコマンド `koe-convert` で UTAU 音源を `.koe` アーカイブに変換する。

```bash
npx koe-convert <音源フォルダ> -o voice.koe
```

あるいはコードから変換する:

```ts
import { parseOto, parseWav, toMono, resample, normalizePcm, pack, packKoe, parseFrqAverageF0, frqFileName, pitchFromAliasSuffix } from "@onjmin/koe";

// oto.ini をパース
const otoText = await fs.readFile("voice/oto.ini", "utf8");
const entries = parseOto(otoText);

// 各エントリを PackInput に変換
const inputs = await Promise.all(entries.map(async (oto) => {
  const wavBuf = await fs.readFile(`voice/${oto.file}`);
  const wav = parseWav(wavBuf.buffer);
  const mono = toMono(wav);
  const resampled = resample(mono, wav.sampleRate, 48000);
  const pcm = normalizePcm(resampled); // Int16Array

  // .frq ファイルからピッチ取得 (任意)
  let recordedPitch = pitchFromAliasSuffix(oto.alias); // エイリアス末尾から推定
  if (!recordedPitch) {
    try {
      const frqBuf = await fs.readFile(`voice/${frqFileName(oto.file)}`);
      recordedPitch = parseFrqAverageF0(frqBuf.buffer);
    } catch {}
  }

  return { oto, pcm, recordedPitch };
}));

// 変換してパック
const { manifest, bin } = pack(inputs, 220 /* referencePitch Hz */);
const blob = packKoe(manifest, [bin]);

// blob を voice.koe として保存 (Node.js)
const buf = Buffer.from(await blob.arrayBuffer());
await fs.writeFile("voice.koe", buf);
```

---

### 2. KoeEngine — リアルタイム再生 (ブラウザ)

AudioWorklet を使った連接合成エンジン。`koe-worklet.js` を同じオリジンから配信する必要がある。

GitHub Pages にホストされているファイルをそのまま使える:

```ts
import { KoeEngine } from "@onjmin/koe";

const engine = new KoeEngine({
  workletUrl: "https://onjmin.github.io/koe/demo/koe-worklet.js",
});

// .koe ファイルをロード (Blob でも URL でも可)
await engine.load("/voice.koe");

// ノートシーケンスを再生
await engine.play([
  { phoneme: "a",  pitch: 440,  duration: 48000 }, // 1秒 / A4
  { phoneme: "i",  pitch: 494,  duration: 24000 }, // 0.5秒 / B4
  { phoneme: "u",  pitch: 392,  duration: 48000 }, // 1秒 / G4
]);

// 停止
engine.stop();

// ブラウザの autoplay ポリシーで停止した場合
await engine.resume();
```

**NoteEvent の型:**

```ts
interface NoteEvent {
  phoneme: string;  // 音素エイリアス (oto.ini の alias)
  pitch: number;    // 出力ピッチ (Hz)
  duration: number; // 出力長 (サンプル数 @ 48kHz)
}
```

---

### 3. VoiceBank — 音素 PCM の直接取得

AudioContext 不要。WORLD ボコーダや独自の合成処理に PCM を渡したい場合に使う。

```ts
import { VoiceBank } from "@onjmin/koe";

// URL からロード (HTTP Range リクエストを使用)
const bank = await VoiceBank.load("/voice.koe");

// Blob からロード
const blob = await fetch("/voice.koe").then(r => r.blob());
const bank2 = await VoiceBank.load(blob);

// マニフェスト参照
console.log(bank.manifest.phonemes); // 全音素のオフセット・ピッチ情報

// Float64 PCM 取得 ([-1, 1] 正規化済み)
const pcm = await bank.getPcm("a");

// Int16 PCM バイト列を取得 (AudioWorklet への転送用)
const buf = await bank.readPcmBytes("a");

// 音素の存在確認
bank.has("a"); // boolean
```

---

### 4. Worldline — 高品質ノート合成 (WORLD ボコーダ)

OpenUtau の worldline WASM で F0 分析・再合成を行う。`worldline.js` と `worldline.wasm` を配信する必要がある。

GitHub Pages にホストされているファイルをそのまま使える:

```ts
import { VoiceBank, Worldline, leadInFromEntry } from "@onjmin/koe";

const bank = await VoiceBank.load("/voice.koe");
const wl   = await Worldline.load({
  scriptUrl: "https://onjmin.github.io/koe/demo/world/worldline.js",
});

const alias = "a";
const entry = bank.manifest.phonemes[alias];
const pcm   = await bank.getPcm(alias);

// ノートをレンダリング → Float32 PCM @ 48kHz
const audio = wl.renderNote({
  pcm,
  pitch: 440,        // Hz
  durationMs: 500,   // 母音部分の長さ (ms)
  ...leadInFromEntry(entry), // preMs / consonantMs を entry から自動計算
});

if (audio) {
  // audio: Float32Array (レイアウト: [子音 ≈ preMs][母音 ≈ durationMs])
  const ctx = new AudioContext({ sampleRate: 48000 });
  const buf = ctx.createBuffer(1, audio.length, 48000);
  buf.copyToChannel(audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}
```

---

### 5. .koe アーカイブ形式

```
[4B] magic 'KOE\0' (big-endian)
[4B] JSON 長 (little-endian)
[N ] manifest JSON (UTF-8)
[M ] PCM バイナリ (Int16 / 48kHz / mono)
```

パース・生成ユーティリティ:

```ts
import { packKoe, parseKoeHeader, pcmBase } from "@onjmin/koe";

// 生成
const blob = packKoe(manifest, [pcmArrayBuffer]);

// ヘッダ解析
const headerBuf = await blob.slice(0, 8).arrayBuffer();
const { jsonLength } = parseKoeHeader(headerBuf);
const pcmOffset = pcmBase(jsonLength); // PCM データの開始バイト位置
```

---

## API リファレンス

| エクスポート | 説明 |
|---|---|
| `KoeEngine` | AudioWorklet ベースの連接合成エンジン |
| `VoiceBank` | .koe から音素 PCM をオンデマンド取得 |
| `Worldline` | WORLD ボコーダによる高品質ノート合成 |
| `parseOto` | oto.ini テキストをパース |
| `parseWav` | WAV バイナリをパース |
| `toMono` | ステレオ → モノラル変換 |
| `resample` | サンプルレート変換 |
| `normalizePcm` | Float → Int16 正規化 |
| `pack` | 音素リスト → manifest + PCM バイナリ |
| `trimToOto` | WAV を oto リージョンにトリミング |
| `packKoe` | manifest + PCM → .koe Blob |
| `parseKoeHeader` | .koe ヘッダ解析 |
| `pcmBase` | JSON長 → PCM 開始バイト位置 |
| `detectF0` | PCM からピッチ自動検出 |
| `noteNameToHz` | 音名 → Hz 変換 (例: `"A4"` → `440`) |
| `pitchFromAliasSuffix` | エイリアス末尾の音名からピッチ推定 |
| `parseFrqAverageF0` | .frq ファイルから平均 F0 取得 |
| `frqFileName` | WAV ファイル名 → .frq ファイル名 |
| `leadInFromEntry` | PhonemeEntry → preMs / consonantMs 変換 |
| `samplesToMs` | サンプル数 → ミリ秒変換 |

---

## ライセンス

MIT
