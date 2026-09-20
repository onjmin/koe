# koe

ブラウザ上でUTAU音源をラグ無しで再生するnpmモジュール。

UTAU の oto.ini で定義された音源を `.koe` アーカイブに変換し、WebAssembly + AudioWorklet でリアルタイム再生・高品質再合成を行う。
oto.ini が無い収録済み wav フォルダからは、原音設定そのものを自動生成できる。

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

### 1. 原音設定の自動生成 (wav → oto.ini)

収録済みの wav フォルダから oto.ini を生成する。CLI と [DEMO ページ](https://onjmin.github.io/koe/demo) の両方から使える。

#### GUI から

DEMO ページの「原音設定 — oto.ini を作る」カードで、wav フォルダ（または zip）を選んでボタンを押すだけ。wav が入っているフォルダごとに oto.ini ができ、そのまま保存（複数フォルダなら zip）できる。「変換へ」を押すと、作った oto.ini をそのまま使って `.koe` を生成し、その場で歌わせて確認できる。

エイリアス接尾辞と、`- か` / `* あ` エイリアスを作るかどうかはカード内で切り替えられる。処理はすべてブラウザ内で完結し、wav はどこにも送信されない。

#### CLI から

```bash
npx koe-oto <音源フォルダ>
```

フォルダを渡すだけで、その下の「wav が置かれている全フォルダ」それぞれに oto.ini が書き出される。

| オプション | 説明 |
| --- | --- |
| `-n`, `--dry-run` | 書き込まず、生成結果の件数だけ表示する |
| `-f`, `--force` | 既存の oto.ini を上書きする (`oto.ini.bak` を残す) |
| `--suffix <s>` | 全エイリアスの末尾に `<s>` を付ける (既定: フォルダ名が音階名なら `_G4` 等) |
| `-q`, `--quiet` | 集計行だけ出力する |

既存の oto.ini があるフォルダは既定でスキップする。上書きしたい場合のみ `--force` を付ける。

#### 収録方式の判定

ファイル名がそのまま音素の書き起こしになっているので、方式はファイル名から決まる。

| ファイル名 | 判定 | 生成されるエイリアス |
| --- | --- | --- |
| `か.wav` / `_きゃ.wav` | 単独音 | `か`, `- か` |
| `_あ.wav` | 単独音 (母音) | `あ`, `- あ`, `* あ` |
| `_ああいあうえあ.wav` | 連続音 | `- あ`, `a あ`, `a い`, `i あ`, … |
| `_ああR.wav` | 連続音 + 語尾 | `- あ`, `a あ`, `a R` (語尾ファイルの `R` が優先される) |
| `_あb.wav` / `_ううわ↑.wav` | テイク違い | `あb`, `- あb` / `- う↑`, `u う↑` … |
| `_xか.wav` | 語頭記号付き | `xか`, `- xか` |
| `カラオケ.wav` | 仮名として読めない → スキップ | — |

カタカナ・拗音・外来音 (`ヴぁ`, `てぃ`, `つぉ` 等) も解決する。仮名の前後に付いた `x` / `b` / `2` / `↑↓` のようなテイク記号はエイリアスに引き継ぐ。仮名として読めないファイルは音声ではないものとして飛ばすので、伴奏やサンプル曲が混ざったフォルダでもそのまま渡せる。

連続音では、語尾ファイル (`_ああR.wav`) が無くても、各ファイルの最後のモーラが消えていく部分から母音ごとに 1 件ずつ `a R` … `n R` を作る (語尾ファイルがあればそちらを優先し、無ければいちばん長く減衰しているテイクを使う)。フレーズ末の音符は `a R` が無いと wavtool の 35ms フェードで切られるため。また、収録リストに `を` が無ければ `お` の各エイリアスを `を` にも複製する (歌詞は助詞を `を` と書くので、無いと音符が抜ける)。

連続音の拍間隔はフォルダ全体の中央値で揃える。渡りの音 (`_うぃうぉうぃううぇ.wav`) のように立ち上がりが弱いファイルは、単独で測ると拍の約数を拾って値が崩れるので、他のファイルと大きく違う間隔になったものはフォルダの拍間隔で当て直す。

フォルダ名が音階そのもの (`G4`) か、音階タグを含む (`多音階03：_G4（連続音）`) 場合は、多音階音源としてエイリアス末尾に `_G4` を付ける。音源全体で oto.ini のエイリアスは1つの名前空間に混ざるため、これが無いと音階ごとの `- あ` が互いを上書きしてしまう。

#### 推定のしかた

[UTAU音源制作wiki の原音設定記事](https://w.atwiki.jp/vbmaker/pages/17.html) のセオリーをそのまま実装している。

- **オフセット** — 子音の立ち上がりの少し手前。さ行・は行のような摩擦音は 4kHz 以上の帯域で先に立ち上がるので、その帯域を見て検出する。
- **先行発声** — 母音の開始点。無声子音 (か・さ・た・は・ぱ行) は声帯が鳴り出した瞬間、な・ま・ら行は鼻音/はじき音が開放された瞬間、や・わ行は渡りの中間。
- **子音部 (固定範囲)** — 母音に入ってスペクトルが落ち着くまで。伸縮されるのが定常部の母音だけになる。
- **オーバーラップ** — 先行発声に対する比で決める。共鳴音 (な・ま・ら・や・わ行) はおよそ 0.6 倍、摩擦音・破擦音は 0.3 倍、下限 12ms・上限 40ms。か・た・ぱ行は破裂前の無音を再現するため負値 (−10ms)。母音単体は 20ms 固定。
- **右ブランク** — 減衰が始まる手前。負値 (オフセットからの相対値) で書き出す。

連続音はガイドBGMに合わせて収録されるため、モーラが等間隔に並ぶ。オンセット検出の自己相関からテンポを求め、グリッドを当ててから各モーラを最寄りのオンセットに吸着させる。テンポが求まれば先行発声 = 間隔の 1/2、オーバーラップ = その 1/3、固定範囲 = その 1.5 倍、右ブランク = ノートの 2/3 間隔先、という既存音源が共通して使っているテンプレートを当てる。

#### 精度

手作業の音源との一致度 (絶対時刻でのずれ)。`重音テト単独音` は人力精度が高い音源として比較対象にした。

| 音源 | 方式 | 先行発声 ≤20ms | ≤40ms | 中央絶対誤差 |
| --- | --- | --- | --- | --- |
| 重音テト単独音 | 単独音 | 72% | 85% | 11ms |
| 欲音ルコ♀ A3 | 連続音 | 53% | 81% | 18ms |
| つくよみちゃん _G4 | 連続音 | 42% | 71% | 25ms |
| 束音ロゼ G4 | 連続音 | 43% | 61% | 28ms |
| 欲音ルコ♂ | 連続音 | 30% | 55% | 37ms |

テトでは他のパラメータも、オフセット ≤20ms 89% / 中央絶対誤差 8ms、オーバーラップ ≤20ms 79% / 10.6ms、右ブランク ≤20ms 85% / 8ms。一番緩いのは子音部 (固定範囲) で中央絶対誤差 34ms だが、これは伸縮の開始位置を決めるだけなのでリズムには効かない。

連続音は音源ごとのテンプレート方針の差がそのまま誤差に出るため、単独音より一致率が落ちる (欲音ルコ♂ は人力でモーラごとに詰めてある音源)。

setParam の自動推定と同程度で、そのまま歌わせられる水準ではあるが、商用配布するなら人の手で詰める前提の出力。

なお `息.wav` `咳払い.wav` のような非言語音は、歌詞が仮名で書かれていない以上どんなエイリアスを振るべきか決めようがないのでスキップする (スキップしたファイルは `GenerateResult.skipped` と CLI の集計に出る)。必要ならその数行だけ手で足すことになる。

#### コードから使う

ブラウザでもそのまま動く (`fs` に依存しない)。

```ts
import { generateOto, formatOto, encodeOto } from "@onjmin/koe";

const files = [{ name: "_あ.wav", data: arrayBuffer }, /* ... */];
const { entries, skipped, style } = generateOto(files, { suffix: "_G4" });

console.log(style);          // "solo" | "sequence" | "mixed"
console.log(formatOto(entries));  // oto.ini のテキスト
const bytes = encodeOto(entries); // Shift-JIS の Uint8Array
```

`generateOto` は同期処理なので、フォルダが大きいとブラウザのUIが固まる。進捗を出したい場合は1ファイルずつ回す:

```ts
import { generateOtoForFile, summarise } from "@onjmin/koe";

for (const file of files) {
  const { entries, skipped, style } = generateOtoForFile(file, { suffix: "_G4" });
  // …集計して、ここでイベントループに制御を返す
}
```

`generateOto` が返す `entries` は `parseOto` と同じ `OtoEntry[]` なので、そのまま `pack()` に渡して `.koe` 化できる。

---

### 2. 音源の変換 (oto.ini → .koe)

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

### 3. KoeEngine — リアルタイム再生 (ブラウザ)

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

### 4. VoiceBank — 音素 PCM の直接取得

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

### 5. Worldline — 高品質ノート合成 (WORLD ボコーダ)

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

### 6. UtauTTS 読み上げ (日本語 TTS)

[UtauTTS](https://github.com/onjmin/UtauTTS) の前半（読み・アクセント解析 → ユニット選択 → 時間計画 → TCN イントネーション → worldline 配置）を Wasm で実行し、波形は `Worldline` で合成する。必要なアセットは 3 つで、いずれも DEMO と同じ配置で配信する（`dist/utautts/` にも同梱）:

| アセット | サイズ | 役割 |
|---|---|---|
| `utautts/utautts.wasm` + `wasm_exec.js` | 約 10MB (gzip 3.5MB) | UtauTTS プランナー (Go) |
| `utautts/jpreprocess_wasm/` + `naist-jdic/*.gz` | 1.4MB + 約 29MB | OpenJTalk 互換の読み・アクセント解析と辞書 |
| `utautts/frame-intonation-v8.json` | 1MB | TCN イントネーションモデル |
| `utautts/hts/tohoku-f01-neutral.htsvoice` | 2MB | HTS 音声モデル（東北大学 伊藤・能勢研究室 tohoku-f01, CC BY 4.0）。音素長と F0 だけを取り出して UTAU 音源に移植する |

```ts
import {
  VoiceBank, Worldline, UtauTTSAdapter, openjtalkAnalyze, alignHtsProsody, shapeProsody, isQuestion,
  resolveSpeakingStyle, styleAlignOptions, styleShapeOptions, styleRenderOptions,
  fetchAsset, fetchAssetBytes, fetchAssetText, loadNaistJdic, initJpreprocessDictionary,
} from "@onjmin/koe";
import initJpreprocess, * as jpreprocess from "./utautts/jpreprocess_wasm/jpreprocess_wasm.js";
// <script src="./utautts/wasm_exec.js"></script> を先に読み込んでおく

// 初回のみ。fetchAsset は Cache API に保存するので 2 回目以降はネットワークを使わない。
await initJpreprocess({ module_or_path: fetchAsset("./utautts/jpreprocess_wasm/jpreprocess_wasm_bg.wasm") });
initJpreprocessDictionary(jpreprocess, await loadNaistJdic("./utautts/jpreprocess_wasm/naist-jdic"));
await UtauTTSAdapter.initializeWasm("./utautts/utautts.wasm", { fetch: fetchAsset });
UtauTTSAdapter.setModel(await fetchAssetText("./utautts/frame-intonation-v8.json"));

const bank = await VoiceBank.load("/voice.koe");
const wl = await Worldline.load({ scriptUrl: "./world/worldline.js" });
const tts = new UtauTTSAdapter(wl);

const text = "こんにちは、私の名前はテトです。";
const { features } = openjtalkAnalyze(JSON.parse(jpreprocess.analyze_text(text)));

// 韻律は 2 通り。HTS 音声モデルの音素長と F0 を移植する（推奨、アクセントの起伏が大きい）か、
// UtauTTS の TCN モデルに任せる（prosody を渡さない）。
// tohoku-f01 は neutral / happy / sad / angry の 4 感情（CC BY 4.0、各約 2MB）。init_voice を呼び直せば差し替わる
jpreprocess.init_voice(await fetchAssetBytes("./utautts/hts/tohoku-f01-neutral.htsvoice"));
// 話し方: "neutral" / "calm"（朗読調）/ "lively"、またはプリセット＋上書き（{ preset: "calm", speed: 0.95 }）
const style = resolveSpeakingStyle("calm");
const frames = JSON.parse(jpreprocess.analyze_prosody(text, style.speed));   // 音素ごとの長さ + 5ms 刻みの F0。第 2 引数は話速（1 = モデルの速さ、約 7 モーラ/秒）、第 3 引数は F0 の GV 重み（GV を持つ音声モデルでのみ有効、tohoku-f01 には無い）
let prosody = alignHtsProsody(frames, features, styleAlignOptions(style)); // モーラに整列（失敗時 null）。抑揚幅 = intonationStrength
// 規則による残差: 「？」で終わる文の語尾上げ、無声化母音（です・ます）の減音、
// 句読点別のポーズ長（「。」650ms／「、」380ms × pauseScale）、モーラ長のコントラスト拡大（HTS の過平滑化を補う）、基準ピッチのシフト
if (prosody) prosody = shapeProsody(prosody, features, { ...styleShapeOptions(style), question: isQuestion(text) });
const plan = tts.plan(bank, text, features, { prosody: prosody ?? undefined }); // 選択・タイミング・F0 曲線・worldline 配置

// チャンクごとに合成 → 届いた順にスケジュールすると数モーラ分で再生が始まる
const ctx = new AudioContext({ sampleRate: 48000 });
const t0 = ctx.currentTime + 0.1;
for await (const chunk of tts.renderChunks(bank, plan, styleRenderOptions(style))) { // 合成後にユニット音量の平準化と F0 連動の音量曲線を掛ける
  const buf = ctx.createBuffer(1, chunk.pcm.length, 48000);
  buf.copyToChannel(chunk.pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(t0 + chunk.startMs / 1000);   // 重なる部分は等パワーのクロスフェード済み
}

// 一括で 1 本の Float32Array が欲しいとき
const pcm = await tts.synthesizeText(bank, text, features);
```

`plan()` のオプション（`tone`, `moraDurationMs`, `pauseDurationMs`, `releaseMs`, `applyPitch`, `intonationStrength`, `speechTiming`）は `utautts-cli` と同じ意味・既定値。ピッチの基準は各音素の収録ピッチ（manifest の `pitch`）で、TCN の輪郭はそこからの相対値として掛かる。

---

### 7. .koe アーカイブ形式

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
| `UtauTTSAdapter` | UtauTTS プランナー (Wasm) + worldline による日本語読み上げ。`plan` / `renderChunks` / `synthesizeText` |
| `openjtalkAnalyze`, `sparse_features`, `readingFromFeatures` | jpreprocess の NJD 出力 → モーラ特徴量・読み |
| `resolveSpeakingStyle`, `SPEAKING_STYLES`, `styleAlignOptions` / `styleShapeOptions` / `styleRenderOptions` | 話し方プリセット（neutral / calm / lively）: 話速・抑揚・基準ピッチ・ポーズ倍率・モーラ長コントラスト・音量曲線の束を各段のオプションに展開 |
| `alignHtsProsody`, `shapeProsody`, `isQuestion` | HTS の音素長・F0 をモーラに整列し、疑問の語尾上げ・無声化・句読点別ポーズ長・モーラ長コントラストの規則を重ねる（`shapeDurations` / `warpPitchCurve` / `pauseKind` も個別に利用可）。F0 連動の音量包絡とユニット音量の平準化は `renderChunks` がレンダリング後に滑らかなゲイン曲線として掛ける |
| `fetchAsset`, `loadNaistJdic`, `initJpreprocessDictionary` | Cache API 付きアセット取得と naist-jdic 辞書の読み込み |
| `generateOto` | wav 群 → oto.ini エントリを推定 (原音設定) |
| `generateOtoForFile` | wav 1本ぶんの推定 (進捗表示したいとき用) |
| `formatOto` / `encodeOto` | エントリ → oto.ini テキスト / Shift-JIS バイト列 |
| `analyze` / `analyzeWav` | WAV → フレーム特徴量 (RMS・有声度・スペクトル) |
| `estimateSolo` / `estimateSequence` | 単独音 / 連続音 1ファイル分のパラメータ推定 |
| `detectGrid` | 連続音のモーラ位置とテンポを検出 |
| `splitKana` | 仮名文字列 → モーラ (子音・母音・調音種別) |
| `transcribe` | wav ファイル名 → モーラ列 |
| `parseOto` | oto.ini テキストをパース |
| `parseWav` | WAV バイナリをパース |
| `toMono` | ステレオ → モノラル変換 |
| `resample` | サンプルレート変換 |
| `normalizePcm` | Float → Int16 正規化 |
| `pack` | 音素リスト → manifest + PCM バイナリ |
| `trimToOto` | WAV を oto リージョンにトリミング |
| `packKoe` | manifest + PCM → .koe Blob |
| `parseKoeHeader` | .koe ヘッダ解析 |
| `unzipToFileMap` / `zipFiles` | zip の展開 / 作成 |
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
