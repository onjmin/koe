package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"
	
	"utautts/internal/frontend"
	"utautts/internal/oto"
	"utautts/internal/plan"
	"utautts/internal/prosody"
	"utautts/internal/voicebank"
)

// WasmRequest defines the input from JS.
type WasmRequest struct {
	Text        string                     `json:"text"`
	Morae       []frontend.Mora            `json:"morae,omitempty"` // Option to bypass OpenJTalk
	Frames      []prosody.FeatureFrame     `json:"frames,omitempty"`
	OtoEntries  map[string][]oto.Entry     `json:"oto_entries"`
	ModelJSON   string                     `json:"model_json,omitempty"`
	Tone        string                     `json:"tone"`
	DurationMS  float64                    `json:"duration_ms"`
}

func main() {
	fmt.Println("UtauTTS Wasm Initialized")
	js.Global().Set("utautts_plan", js.FuncOf(utauttsPlan))
	select {} // Block forever
}

func utauttsPlan(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorToJS("missing request argument")
	}

	reqJSON := args[0].String()
	var req WasmRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return errorToJS(fmt.Sprintf("failed to parse request: %v", err))
	}

	// 1. Prepare Voicebank
	bank := &voicebank.Bank{
		Root:      "/dummy",
		Name:      "WasmBank",
		Entries:   req.OtoEntries,
		PrefixMap: map[string]voicebank.Affix{},
	}
	// We need to bypass the file-based loaders, so we manually set up extractor?
	// The extractor relies on audio caching (connection.Extractor). It might work without files if we only do Viterbi based on simple cost, or it might fail if it tries to read wav files to calculate join costs.
	// Let's see if we can resolve without audio files. The handcrafted join cost might need them if not cached?
	
	// 2. Prepare Morae
	morae := req.Morae
	if len(morae) == 0 && req.Text != "" {
		// Use simple kagome conversion for testing
		reading, err := frontend.ToKana(req.Text)
		if err != nil {
			return errorToJS(fmt.Sprintf("ToKana error: %v", err))
		}
		morae, err = frontend.ParseKana(reading)
		if err != nil {
			return errorToJS(fmt.Sprintf("ParseKana error: %v", err))
		}
	}

	// 3. Prepare Prosody Model (if provided)
	var model *prosody.Model
	if req.ModelJSON != "" {
		var m prosody.Model
		if err := json.Unmarshal([]byte(req.ModelJSON), &m); err != nil {
			return errorToJS(fmt.Sprintf("failed to parse model: %v", err))
		}
		model = &m
	}

	// 4. Resolve Voicebank (Viterbi)
	selections, err := bank.ResolveWithConfig(morae, voicebank.ResolveConfig{
		Tone: req.Tone,
		AliasPolicy: voicebank.AliasPolicyAuto,
	})
	if err != nil {
		return errorToJS(fmt.Sprintf("Resolve error: %v", err))
	}

	// 5. Generate Plan
	// For testing, we just return the selections or a simple plan structure.
	// Normally `tts.Synthesis` handles the full pipeline, but it's tightly coupled to Context/Engine.
	// Let's just manually build a basic Plan to prove Viterbi and TCN work.
	
	p := &plan.Plan{
		Version: plan.Version,
		Voicebank: bank.Name,
		Text: req.Text,
	}
	
	// If model is provided, run TCN (just testing execution, we might not have full features)
	if model != nil {
		// Note: dummy timings
		timings := make([]prosody.MoraTiming, len(morae))
		for i := range timings {
			timings[i] = prosody.MoraTiming{StartMS: float64(i) * 100, DurationMS: 100}
		}
		
		frames := req.Frames
		if frames == nil {
			frames = make([]prosody.FeatureFrame, 0)
		}
		
		duration := req.DurationMS
		if duration == 0 {
			duration = float64(len(morae)) * 100
		}
		contour := model.PredictFrameContour(morae, frames, timings, duration, false)
		if contour != nil {
			// Success! TCN ran.
			p.DurationMS = duration
			// Hack: pass contour to JS via an extended Plan structure or just a wrapper
			// We can inject it into a custom JSON response.
			
			// Let's create a custom struct to hold the extended info
			type ExtendedPlan struct {
				*plan.Plan
				PitchCents   []float64 `json:"pitch_cents,omitempty"`
				PitchFrameMS float64   `json:"pitch_frame_ms,omitempty"`
			}
			ep := ExtendedPlan{
				Plan: p,
				PitchCents: contour.Cents,
				PitchFrameMS: contour.FrameMS,
			}
			
			// Output the resolved selections
			for _, sel := range selections {
				ep.Units = append(ep.Units, plan.Unit{
					Mora: sel.Mora.Text,
					Alias: sel.Alias,
					OtoPath: sel.Entry.Filename,
					OffsetMS: sel.Entry.Offset,
					ConsonantMS: sel.Entry.Fixed,
					PreutteranceMS: sel.Entry.Preutterance,
					OverlapMS: sel.Entry.Overlap,
					DurationMS: 100, // Dummy
				})
			}

			outBytes, err := json.Marshal(ep)
			if err != nil {
				return errorToJS(fmt.Sprintf("Marshal plan error: %v", err))
			}

			return js.ValueOf(map[string]any{
				"success": true,
				"plan":    string(outBytes),
			})
		}
	}

	// Output the resolved selections if no model
	for _, sel := range selections {
		p.Units = append(p.Units, plan.Unit{
			Mora: sel.Mora.Text,
			Alias: sel.Alias,
			OtoPath: sel.Entry.Filename,
			OffsetMS: sel.Entry.Offset,
			ConsonantMS: sel.Entry.Fixed,
			PreutteranceMS: sel.Entry.Preutterance,
			OverlapMS: sel.Entry.Overlap,
			DurationMS: 100, // Dummy
		})
	}

	outBytes, err := json.Marshal(p)
	if err != nil {
		return errorToJS(fmt.Sprintf("Marshal plan error: %v", err))
	}

	return js.ValueOf(map[string]any{
		"success": true,
		"plan":    string(outBytes),
	})
}

func errorToJS(msg string) js.Value {
	return js.ValueOf(map[string]any{
		"success": false,
		"error":   msg,
	})
}
