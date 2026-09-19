//go:build !js

package frontend

import (
	"fmt"
	"strings"
	"sync"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

var (
	japaneseOnce      sync.Once
	japaneseTokenizer *tokenizer.Tokenizer
	japaneseError     error
)

func toKana(text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("empty text")
	}
	japaneseOnce.Do(func() {
		japaneseTokenizer, japaneseError = tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
	})
	if japaneseError != nil {
		return "", japaneseError
	}

	var reading strings.Builder
	for _, token := range japaneseTokenizer.Tokenize(text) {
		if pronunciation, ok := token.Pronunciation(); ok && pronunciation != "" && pronunciation != "*" {
			reading.WriteString(pronunciation)
			continue
		}
		if safeSurface(token.Surface) {
			reading.WriteString(token.Surface)
			continue
		}
		if surfaceMayHavePronunciation(token.Surface) {
			return "", fmt.Errorf("no pronunciation for token %q", token.Surface)
		}
		// 絵文字など、読みを持たない部分は発話に含めない。
		continue
	}
	return reading.String(), nil
}
