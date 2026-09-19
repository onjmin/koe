// utautts-wasmはブラウザ向けのUtauTTS前半(発音・選択・計画・ピッチ曲線・worldline配置)。
// 波形生成はJS側のworldline WASM(OpenUtau)が担当し、本バイナリは音声ファイルを読まない。
//
// JSへ公開する関数:
//
//	utautts_set_model(json string) -> {success, error?}   プロソディモデルを一度だけ読み込む
//	utautts_set_bank(json string)  -> {success, error?}   koe音源の仮想oto.iniと収録ピッチを登録する
//	utautts_plan(json string)      -> {success, error?, plan: string}
//
// utautts_planのリクエスト(JSON):
//
//	text, reading, frames(モーラ特徴), tone, mora_duration_ms, pause_duration_ms, release_ms,
//	leading_preutterance_ms, apply_pitch, intonation_strength, speech_timing,
//	oto_entries / source_pitch_hz / model_json (省略時はset_bank/set_modelの値を使う)
package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"utautts/internal/frontend"
	"utautts/internal/oto"
	"utautts/internal/plan"
	"utautts/internal/plugin"
	"utautts/internal/prosody"
	"utautts/internal/render"
	"utautts/internal/tts"
	"utautts/internal/voicebank"
)

// bankRequestはkoe側のマニフェストから作る仮想音源。
type bankRequest struct {
	Name          string                 `json:"name,omitempty"`
	OtoEntries    map[string][]oto.Entry `json:"oto_entries"`
	SourcePitchHz map[string]float64     `json:"source_pitch_hz,omitempty"`
}

type planRequest struct {
	Text                  string                 `json:"text"`
	Reading               string                 `json:"reading,omitempty"`
	Frames                []prosody.FeatureFrame `json:"frames,omitempty"`
	Tone                  string                 `json:"tone,omitempty"`
	MoraDurationMS        float64                `json:"mora_duration_ms,omitempty"`
	PauseDurationMS       float64                `json:"pause_duration_ms,omitempty"`
	ReleaseMS             *float64               `json:"release_ms,omitempty"`
	LeadingPreutteranceMS float64                `json:"leading_preutterance_ms,omitempty"`
	ApplyPitch            *bool                  `json:"apply_pitch,omitempty"`
	IntonationStrength    *float64               `json:"intonation_strength,omitempty"`
	SpeechTiming          bool                   `json:"speech_timing,omitempty"`
	WordBoundaryEnvelope  bool                   `json:"word_boundary_envelope,omitempty"`
	// 互換: 1回のリクエストで音源とモデルを渡す旧形式。
	OtoEntries    map[string][]oto.Entry `json:"oto_entries,omitempty"`
	SourcePitchHz map[string]float64     `json:"source_pitch_hz,omitempty"`
	ModelJSON     string                 `json:"model_json,omitempty"`
}

// planResponseはJSへ返す計画。Timelineがworldline PhraseSynthへの配置。
type planResponse struct {
	Reading     string                    `json:"reading"`
	Language    string                    `json:"language"`
	Morae       []frontend.Mora           `json:"morae"`
	Plan        *plan.Plan                `json:"plan"`
	PitchCurve  *render.PitchCurve        `json:"pitch_curve,omitempty"`
	MoraTimings []prosody.MoraTiming      `json:"mora_timings"`
	Timeline    *render.WorldlineTimeline `json:"timeline"`
	// 互換フィールド(旧アダプタ用)。
	DurationMS   float64     `json:"duration_ms"`
	Units        []plan.Unit `json:"units"`
	PitchCents   []float64   `json:"pitch_cents,omitempty"`
	PitchFrameMS float64     `json:"pitch_frame_ms,omitempty"`
}

var (
	currentModel *prosody.Model
	currentBank  *voicebank.Bank
	currentPitch map[string]float64
)

func main() {
	fmt.Println("UtauTTS Wasm Initialized")
	js.Global().Set("utautts_set_model", js.FuncOf(setModel))
	js.Global().Set("utautts_set_bank", js.FuncOf(setBank))
	js.Global().Set("utautts_plan", js.FuncOf(utauttsPlan))
	select {}
}

func setModel(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorToJS("missing model argument")
	}
	text := args[0].String()
	if text == "" {
		currentModel = nil
		return js.ValueOf(map[string]any{"success": true})
	}
	model, err := prosody.ParseModel([]byte(text))
	if err != nil {
		return errorToJS(fmt.Sprintf("failed to parse model: %v", err))
	}
	currentModel = model
	return js.ValueOf(map[string]any{"success": true, "id": model.ID})
}

func setBank(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorToJS("missing bank argument")
	}
	var req bankRequest
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return errorToJS(fmt.Sprintf("failed to parse bank: %v", err))
	}
	if len(req.OtoEntries) == 0 {
		return errorToJS("bank has no oto entries")
	}
	currentBank = buildBank(req.Name, req.OtoEntries)
	currentPitch = req.SourcePitchHz
	return js.ValueOf(map[string]any{"success": true, "aliases": len(req.OtoEntries)})
}

func buildBank(name string, entries map[string][]oto.Entry) *voicebank.Bank {
	if name == "" {
		name = "koe"
	}
	for alias, list := range entries {
		for index := range list {
			if list[index].Alias == "" {
				list[index].Alias = alias
			}
			if list[index].Filename == "" {
				list[index].Filename = "koe:" + alias
			}
		}
	}
	return &voicebank.Bank{
		Root:      "/koe/" + name,
		Name:      name,
		Entries:   entries,
		PrefixMap: map[string]voicebank.Affix{},
	}
}

func utauttsPlan(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorToJS("missing request argument")
	}
	var req planRequest
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return errorToJS(fmt.Sprintf("failed to parse request: %v", err))
	}

	bank, pitchByAlias := currentBank, currentPitch
	if len(req.OtoEntries) > 0 {
		bank = buildBank("", req.OtoEntries)
		pitchByAlias = req.SourcePitchHz
	}
	if bank == nil {
		return errorToJS("no voicebank: call utautts_set_bank first")
	}
	model := currentModel
	if req.ModelJSON != "" {
		parsed, err := prosody.ParseModel([]byte(req.ModelJSON))
		if err != nil {
			return errorToJS(fmt.Sprintf("failed to parse model: %v", err))
		}
		model = parsed
	}

	if req.Text == "" {
		return errorToJS("text is empty")
	}
	reading := req.Reading
	if reading == "" {
		// かな入力のみ対応。漢字かな交じり文はJS側(jpreprocess)で読みへ変換する。
		reading = req.Text
	}

	// 既定値はutautts-cliと同じ。apply_pitchはTCN輪郭を使うため既定で有効にする。
	applyPitch := true
	if req.ApplyPitch != nil {
		applyPitch = *req.ApplyPitch
	}
	intonationStrength := 1.0
	if req.IntonationStrength != nil {
		intonationStrength = *req.IntonationStrength
	}
	releaseMS := 20.0
	if req.ReleaseMS != nil {
		releaseMS = *req.ReleaseMS
	}
	tone := req.Tone
	if tone == "" {
		tone = "C4"
	}

	cfg := tts.Config{
		Voicebank:             bank,
		Text:                  req.Text,
		Reading:               reading,
		Language:              "ja",
		Tone:                  tone,
		MoraDurationMS:        req.MoraDurationMS,
		PauseDurationMS:       req.PauseDurationMS,
		ReleaseMS:             releaseMS,
		ReleaseSet:            true,
		LeadingPreutteranceMS: req.LeadingPreutteranceMS,
		ProsodyModel:          model,
		ProsodyFeatures:       req.Frames,
		ApplyPitch:            applyPitch,
		IntonationStrength:    intonationStrength,
		SpeechTiming:          req.SpeechTiming,
		WordBoundaryEnvelope:  req.WordBoundaryEnvelope,
		Renderer:              "worldline",
		RendererCapabilities:  &plugin.Capabilities{FramePitch: true},
		AliasPolicy:           voicebank.AliasPolicyAuto,
	}
	speech, err := tts.BuildSpeechPlan(cfg)
	if err != nil {
		return errorToJS(fmt.Sprintf("plan error: %v", err))
	}

	sourcePitches := make([]float64, len(speech.Plan.Units))
	for index, unit := range speech.Plan.Units {
		sourcePitches[index] = pitchByAlias[unit.Alias]
	}
	timeline, err := render.BuildWorldlineTimeline(speech.Plan, render.WorldlineTimelineConfig{
		ReleaseMS:             releaseMS,
		LeadingPreutteranceMS: req.LeadingPreutteranceMS,
		ApplyPitch:            speech.ApplyPitch,
		IntonationStrength:    speech.IntonationStrength,
		PitchCurve:            speech.PitchCurve,
		SourcePitches:         sourcePitches,
	})
	if err != nil {
		return errorToJS(fmt.Sprintf("timeline error: %v", err))
	}

	response := planResponse{
		Reading:     speech.Reading,
		Language:    speech.Language,
		Morae:       speech.Morae,
		Plan:        speech.Plan,
		PitchCurve:  speech.PitchCurve,
		MoraTimings: speech.MoraTimings,
		Timeline:    timeline,
		DurationMS:  speech.Plan.DurationMS,
		Units:       speech.Plan.Units,
	}
	if speech.PitchCurve != nil {
		response.PitchCents = speech.PitchCurve.Cents
		response.PitchFrameMS = speech.PitchCurve.FrameMS
	}
	out, err := json.Marshal(response)
	if err != nil {
		return errorToJS(fmt.Sprintf("marshal plan error: %v", err))
	}
	return js.ValueOf(map[string]any{"success": true, "plan": string(out)})
}

func errorToJS(msg string) js.Value {
	return js.ValueOf(map[string]any{"success": false, "error": msg})
}
