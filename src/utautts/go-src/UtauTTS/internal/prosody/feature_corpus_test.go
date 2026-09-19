package prosody

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAndSelectFeatureCorpus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "features.json")
	data := []byte(`{"version":1,"cases":[{"id":"hello","text":"こんにちは。","features":[{"accent_high":1}]},{"id":"weather","reading":"テンキデス。","features":[{"word_end":1}]}]}`)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	corpus, err := LoadFeatureCorpus(path)
	if err != nil {
		t.Fatal(err)
	}
	byText, err := corpus.Select("", " こんにちは。 ", "")
	if err != nil || byText.ID != "hello" {
		t.Fatalf("text selection = %#v, %v", byText, err)
	}
	byReading, err := corpus.Select("", "", "テンキ デス。")
	if err != nil || byReading.ID != "weather" {
		t.Fatalf("reading selection = %#v, %v", byReading, err)
	}
	byID, err := corpus.Select("weather", "different", "")
	if err != nil || byID.Features[0]["word_end"] != 1 {
		t.Fatalf("id selection = %#v, %v", byID, err)
	}
}

func TestFeatureCorpusRequiresSelectorWhenAmbiguous(t *testing.T) {
	corpus := FeatureCorpus{Version: 1, Cases: []FeatureCase{
		{ID: "a", Text: "A", Features: []FeatureFrame{{"x": 1}}},
		{ID: "b", Text: "B", Features: []FeatureFrame{{"x": 2}}},
	}}
	if _, err := corpus.Select("", "unknown", ""); err == nil {
		t.Fatal("ambiguous corpus was selected without an utterance match")
	}
}
