package render

import (
	"math"
	"testing"

	"utautts/internal/frontend"
	"utautts/internal/plan"
)

// 外部韻律の移植時(FlatBasePitch)はユニットの収録ピッチ差がF0曲線に乗らない。
func TestBuildWorldlineTimelineFlatBasePitchIgnoresUnitPitches(t *testing.T) {
	build := func(flat bool) *WorldlineTimeline {
		p := &plan.Plan{
			SingleCV:   true,
			DurationMS: 300,
			Morae:      []frontend.Mora{{Text: "あ", Vowel: "a"}, {Text: "か", Consonant: "k", Vowel: "a"}},
			Units: []plan.Unit{
				{Role: "mora", Position: 0, Mora: "あ", Alias: "あ", NoteStartMS: 0, DurationMS: 150, PreutteranceMS: 5, OverlapMS: 0},
				{Role: "mora", Position: 1, Mora: "か", Alias: "か", NoteStartMS: 150, DurationMS: 150, PreutteranceMS: 30, OverlapMS: 10},
			},
		}
		curve := &PitchCurve{FrameMS: 10, Cents: make([]float64, 40)}
		timeline, err := BuildWorldlineTimeline(p, WorldlineTimelineConfig{
			ReleaseMS: 20, ApplyPitch: true, IntonationStrength: 1,
			PitchCurve: curve, SourcePitches: []float64{240, 300}, FlatBasePitch: flat,
		})
		if err != nil {
			t.Fatal(err)
		}
		return timeline
	}
	flat := build(true)
	for frame, hz := range flat.F0Curve {
		if math.Abs(hz-flat.ReferenceHz) > 1e-6 {
			t.Fatalf("flat base pitch: frame %d = %.3f Hz, want reference %.3f", frame, hz, flat.ReferenceHz)
		}
	}
	for _, unit := range flat.Units {
		if math.Abs(unit.TargetF0Hz-flat.ReferenceHz) > 1e-6 {
			t.Fatalf("flat base pitch: unit %q target %.3f Hz, want %.3f", unit.Alias, unit.TargetF0Hz, flat.ReferenceHz)
		}
	}
	perUnit := build(false)
	varied := false
	for _, hz := range perUnit.F0Curve {
		if math.Abs(hz-perUnit.ReferenceHz) > 1 {
			varied = true
			break
		}
	}
	if !varied {
		t.Fatal("per-unit base pitch should follow the unit pitches")
	}
}
