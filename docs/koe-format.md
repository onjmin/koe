## koe フォーマットの構造

[src/koe.ts](src/koe.ts) と [docs/file.md](docs/file.md) が実体です。

| セクション | サイズ | 内容 |
| --- | --- | --- |
| Magic Number | 4 Bytes | `0x4B 0x4F 0x45 0x00` (`'KOE\0'`, big-endian) |
| JSON Length | 4 Bytes | 後続 manifest JSON のバイト長 (little-endian) |
| Metadata | N Bytes | UTF-8 の manifest.json（oto.ini 由来の数値・音素オフセット等） |
| **PCM Data** | M Bytes | **Raw PCM 波形（Int16 / 48kHz / mono）** |

[koe.ts:11](src/koe.ts:11) のコメントが端的です:

> `[M] raw PCM (Int16 / 48kHz / mono); phoneme offsets are relative to here`

## F0/SP/AP との関係

- PCM Data 層は **時間領域の生波形**のみ。WORLD の音響特徴量（F0=基本周波数 / SP=スペクトル包絡 / AP=非周期性指標）は **格納していません**。
- つまり koe はあくまで「波形＋メタデータ」のコンテナであり、F0/SP/AP は**ランタイム側（エンジン）で波形を解析して都度求める**設計です。manifest にはピッチや音素境界などのメタ情報が入りますが、SP/AP のような重い特徴量パックは持ちません。
