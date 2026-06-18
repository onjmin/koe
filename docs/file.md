## 提案：Koe Archive Format (.koe)

このフォーマットを `.koe` 拡張子として定義し、以下の構造でバイト配列を構築します。

### 1. データ構造設計

ランダムアクセス（必要な音素だけを読み込む）を考慮しつつ、パースが極めて単純な設計にします。

| セクション | サイズ | 内容 |
| --- | --- | --- |
| **Magic Number** | 4 Bytes | ファイル識別のための定数 (例: `0x4B 0x4F 0x45 0x00`) |
| **JSON Length** | 4 Bytes | 後続のJSONデータのバイト長 (Little Endian) |
| **Metadata** | N Bytes | UTF-8 エンコードされた manifest.json |
| **PCM Data** | M Bytes | Raw PCM 波形データ |

### 2. メリット

* **Zero-Copy Loading:** ブラウザ上で `fetch` して `ArrayBuffer` を取得すれば、`DataView` や `TypedArray` の `subarray` を使うだけで、メモリを複製せずにメタデータとオーディオデータに分離可能です。
* **Atomic Delivery:** メタデータ（`oto.ini`由来の数値）と実際の波形データが分離することがなく、バージョン不整合によるクラッシュを防げます。
* **CDN Cache Friendly:** 1ファイルであるため、キャッシュのパージや更新が容易です。

---

## 3. 実装の指針

### A. コンバーター（Node.js / TS）

`manifest.json` と `voice.bin` を結合するロジックです。

```typescript
// Pack manifest and binary data into a single buffer
const fs = require('fs');

async function packKoeFile(manifestPath: string, binPath: string, outputPath: string) {
  // 1. Read manifest string and PCM binary
  const manifest = fs.readFileSync(manifestPath, 'utf-8');
  const pcmData = fs.readFileSync(binPath);
  
  // 2. Prepare metadata buffer
  const manifestBuffer = Buffer.from(manifest, 'utf-8');
  
  // 3. Create header (Magic: 4 bytes, Length: 4 bytes)
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0x4B4F4500, 0); // MAGIC: 'KOE\0'
  header.writeUInt32LE(manifestBuffer.length, 4); // JSON Length
  
  // 4. Concatenate and write
  const output = Buffer.concat([header, manifestBuffer, pcmData]);
  fs.writeFileSync(outputPath, output);
}

```

### B. ランタイム（WASM/JS）

WASM側で読み込む際、最初の数バイトをパースしてポインタを計算するだけです。

```javascript
// Load and split the archive
async function loadKoeArchive(url: string) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);

  // 1. Verify Magic Number
  const magic = view.getUint32(0, false);
  if (magic !== 0x4B4F4500) throw new Error("Invalid file format");

  // 2. Parse Manifest Length
  const jsonLength = view.getUint32(4, true);

  // 3. Extract Metadata
  const jsonBuffer = buffer.slice(8, 8 + jsonLength);
  const manifest = JSON.parse(new TextDecoder().decode(jsonBuffer));

  // 4. Extract Audio Binary
  const audioData = buffer.slice(8 + jsonLength);
  
  return { manifest, audioData };
}

```

---

## モバイルファーストへの適用

モバイル環境では、全ファイルを一度にダウンロードするとメモリを圧迫します。この統合フォーマットの最大の強みは、**HTTP Range Request を使った部分読み込みが可能**である点です。

1. **Headerの取得:** まず最初の8バイトだけを取得し、`JSON Length` を確認。
2. **Manifestの取得:** `8` から `8 + jsonLength` までを取得し、JSONとしてパース。
3. **PCMのストリーミング/遅延読み込み:** オーディオデータは、必要な音素が再生されるタイミングまで取得を遅らせるか、`Range` リクエストで必要なチャンクのみをストリーミング再生することが可能です。
