package tts

import (
	"utautts/internal/frontend"
	"utautts/internal/plan"
	"utautts/internal/prosody"
	"utautts/internal/render"
	"utautts/internal/voicebank"
)

// SpeechPlanはレンダラー非依存の合成前半の結果。
// 発音解析、ユニット選択(Viterbi)、時間計画、フレームピッチ曲線までを含み、
// 波形生成だけを外部レンダラー(例: ブラウザ上のworldline WASM)に委ねるために使う。
type SpeechPlan struct {
	Voicebank  *voicebank.Bank
	Language   string
	Phonemizer string
	Reading    string
	Morae      []frontend.Mora
	Plan       *plan.Plan
	// PitchCurveは手動補正を含む最終的なフレームピッチ曲線(cents)。nilなら平坦。
	PitchCurve *render.PitchCurve
	// AutomaticPitchCurveはプロソディモデルが生成した自動曲線。
	AutomaticPitchCurve *render.PitchCurve
	ApplyPitch          bool
	// IntonationStrengthはレンダラーへ渡す音源ピッチ安定化の強さ。
	IntonationStrength float64
	MoraTimings        []prosody.MoraTiming
	// Configは音源プロファイル等を反映した解決済み設定。
	Config Config
}

// BuildSpeechPlanはSynthesizeと同じ手順で計画とピッチ曲線を作り、波形生成は行わない。
func BuildSpeechPlan(cfg Config) (*SpeechPlan, error) {
	if err := synthesisContextError(cfg.Context); err != nil {
		return nil, err
	}
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}
	prep, err := prepareSpeech(cfg)
	if err != nil {
		return nil, err
	}
	return &SpeechPlan{
		Voicebank:           prep.bank,
		Language:            prep.language,
		Phonemizer:          prep.phonemizer,
		Reading:             prep.reading,
		Morae:               prep.morae,
		Plan:                prep.synthesisPlan,
		PitchCurve:          prep.pitchCurve,
		AutomaticPitchCurve: prep.automaticPitchCurve,
		ApplyPitch:          prep.applyPitch,
		IntonationStrength:  prep.intonationStrength,
		MoraTimings:         moraTimings(prep.morae, prep.synthesisPlan),
		Config:              prep.cfg,
	}, nil
}
