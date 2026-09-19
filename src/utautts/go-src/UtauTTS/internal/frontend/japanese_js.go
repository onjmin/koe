//go:build js

package frontend

import "fmt"

// toKanaはWasmビルドでは形態素解析辞書(kagome/ipa, 約12MB)を含めないため未対応。
// 読みはブラウザ側(jpreprocess)で求め、tts.Config.Readingとして渡す。
func toKana(text string) (string, error) {
	return "", fmt.Errorf("kana conversion is unavailable in the wasm build; supply a reading for %q", text)
}
