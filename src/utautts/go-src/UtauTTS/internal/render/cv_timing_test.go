package render

import (
	"math"
	"reflect"
	"testing"

	"utautts/internal/frontend"
	"utautts/internal/plan"
	"utautts/internal/voicebank"
)

func TestNormalizeSingleCVTimingProtectsOnsetAndVowelTail(t *testing.T) {
	p := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{{Consonant: "k", Vowel: "a"}}}
	unit := plan.Unit{
		Role: "mora", Position: 0, DurationMS: 140, PreutteranceMS: 126,
		ConsonantMS: 184, OverlapMS: 0,
		SpeechProfile: &voicebank.SpeechProfile{TrimmedLengthMS: 266, VowelTailMS: 82},
	}
	got := normalizePlanTiming(p, unit, 20)
	if !got.cvApplied || got.preutteranceMS >= unit.PreutteranceMS || got.consonantMS >= unit.ConsonantMS {
		t.Fatalf("timing was not bounded: %+v", got)
	}
	if got.preutteranceMS > 85 || got.preutteranceMS < 80 {
		t.Fatalf("preutterance = %.3f", got.preutteranceMS)
	}
	if got.overlapMS < got.preutteranceMS-19 || math.Abs(got.preutteranceMS-got.overlapMS-18) > 1 {
		t.Fatalf("onset fade was not shortened: %+v", got)
	}
	minimumTail := math.Max(singleCVMinimumVowelTailMS, unit.DurationMS*singleCVVowelTailRatio)
	if got.preutteranceMS+unit.DurationMS+20-got.consonantMS < minimumTail-1e-9 {
		t.Fatalf("vowel tail was not preserved: %+v", got)
	}
}

func TestNormalizeVCVTimingBoundsLongContextAndKeepsVowelTail(t *testing.T) {
	unit := plan.Unit{
		Role: "mora", AliasKind: "VCV", DurationMS: 140,
		PreutteranceMS: 210, OverlapMS: 70, ConsonantMS: 360,
		SpeechProfile: &voicebank.SpeechProfile{
			Applied: true, TrimmedLengthMS: 560, StableStartMS: 335,
		},
	}
	got := normalizePlanTiming(&plan.Plan{}, unit, 20)
	if got.preutteranceMS > 106 || got.preutteranceMS < 100 {
		t.Fatalf("VCV preutterance = %.3f, want about 105", got.preutteranceMS)
	}
	if got.consonantMS <= got.preutteranceMS {
		t.Fatalf("VCV fixed did not retain a transition: %+v", got)
	}
	tail := got.preutteranceMS + unit.DurationMS + 20 - got.consonantMS
	minimumTail := math.Max(vcvMinimumVowelTailMS, unit.DurationMS*vcvVowelTailRatio)
	if tail < minimumTail-1e-9 {
		t.Fatalf("VCV vowel tail = %.3f, want at least %.3f", tail, minimumTail)
	}
	if !got.cvApplied || got.scale >= 1 {
		t.Fatalf("VCV timing was not audited and compressed: %+v", got)
	}
}

func TestNormalizedPhoneTimingUnitsApplyVCVAnchors(t *testing.T) {
	p := &plan.Plan{Units: []plan.Unit{{Role: "mora", AliasKind: "VCV", DurationMS: 140,
		PreutteranceMS: 210, OverlapMS: 70, ConsonantMS: 360}}}
	units := normalizedPhoneTimingUnits(p, 20)
	if len(units) != 1 || units[0].PreutteranceMS >= p.Units[0].PreutteranceMS || units[0].ConsonantMS >= p.Units[0].ConsonantMS {
		t.Fatalf("normalized phone units = %+v", units)
	}
	if p.Units[0].PreutteranceMS != 210 || p.Units[0].ConsonantMS != 360 {
		t.Fatalf("source plan was mutated: %+v", p.Units[0])
	}
}

func TestWorldlineVCVTimingKeepsOTOAnchorsUnlessSpeechTimingIsEnabled(t *testing.T) {
	unit := plan.Unit{Role: "mora", AliasKind: "VCV", DurationMS: 140,
		PreutteranceMS: 210, OverlapMS: 70, ConsonantMS: 360,
		SpeechProfile: &voicebank.SpeechProfile{Applied: true, TrimmedLengthMS: 560, StableStartMS: 335}}
	plain := worldlineTiming(&plan.Plan{}, unit, 20)
	if plain.preutteranceMS != 210 || plain.consonantMS != 360 || plain.overlapMS != 70 {
		t.Fatalf("WORLD default changed oto anchors: %+v", plain)
	}
	optIn := worldlineTiming(&plan.Plan{SpeechTiming: true}, unit, 20)
	if optIn.preutteranceMS >= unit.PreutteranceMS || optIn.consonantMS >= unit.ConsonantMS || !optIn.cvApplied {
		t.Fatalf("WORLD speech timing did not apply VCV normalization: %+v", optIn)
	}
}

func TestWorldlinePhoneTimingUnitsDoesNotMutatePlan(t *testing.T) {
	unit := plan.Unit{Role: "mora", AliasKind: "VCV", DurationMS: 140,
		PreutteranceMS: 210, OverlapMS: 70, ConsonantMS: 360}
	p := &plan.Plan{Units: []plan.Unit{unit}}
	got := worldlinePhoneTimingUnits(p, 20)
	if len(got) != 1 || !reflect.DeepEqual(got[0], unit) {
		t.Fatalf("WORLD default phone timing changed: %+v", got)
	}
	if !reflect.DeepEqual(p.Units[0], unit) {
		t.Fatalf("source plan was mutated: %+v", p.Units[0])
	}
}

func TestSingleCVBoundaryEligibilityProtectsStops(t *testing.T) {
	p := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{
		{Consonant: "a", Vowel: "a"},
		{Consonant: "s", Vowel: "i"},
	}}
	previous := renderedUnit{index: 0, unit: plan.Unit{Role: "mora", Position: 0}}
	current := renderedUnit{index: 1, unit: plan.Unit{Role: "mora", Position: 1}}
	if !singleCVBoundaryEligible(p, previous, current) || singleCVProtectedOnset(p, current.unit) {
		t.Fatal("fricative boundary was rejected")
	}
	p.Morae[1].Consonant = "k"
	if !singleCVProtectedOnset(p, current.unit) {
		t.Fatal("stop boundary was not protected")
	}
}

func TestSingleCVWorldOverlapKeepsOnsetFadeControlled(t *testing.T) {
	p := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{{Consonant: "k", Vowel: "a"}}}
	unit := plan.Unit{Position: 0, PreutteranceMS: 126, OverlapMS: 80}
	if got := singleCVWorldOverlapMS(p, unit, 84); got != 18 {
		t.Fatalf("world overlap = %.3f, want 18", got)
	}
	unit.OverlapMS = 0
	if got := singleCVWorldOverlapMS(p, unit, 84); got != 0 {
		t.Fatalf("zero overlap changed to %.3f", got)
	}
}

func TestSingleCVWorldOverlapAddsVowelBoundaryBlend(t *testing.T) {
	p := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{
		{Vowel: "a"}, {Vowel: "a"}, {Vowel: "i"}, {Consonant: "k", Vowel: "a"},
	}}
	// ユニット長が不明なら話し言葉向けの長い重なりをそのまま使う。
	if got := singleCVWorldOverlapMS(p, plan.Unit{Position: 1}, 0); got != singleCVVowelJoinMS {
		t.Fatalf("same-vowel overlap = %.3f, want %.3f", got, singleCVVowelJoinMS)
	}
	if got := singleCVWorldOverlapMS(p, plan.Unit{Position: 2}, 0); got != singleCVVowelJoinMS {
		t.Fatalf("vowel overlap = %.3f, want %.3f", got, singleCVVowelJoinMS)
	}
	// otoのoverlapが重なりより長ければそれを尊重する。
	if got := singleCVWorldOverlapMS(p, plan.Unit{Position: 2, OverlapMS: 60}, 0); got != 60 {
		t.Fatalf("oto overlap was shortened to %.3f", got)
	}
	if got := singleCVWorldOverlapMS(p, plan.Unit{Position: 3}, 0); got != 0 {
		t.Fatalf("consonant onset overlap = %.3f, want 0", got)
	}
}

func TestSingleCVVowelJoinShrinksForShortMorae(t *testing.T) {
	p := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{{Vowel: "a"}, {Vowel: "i"}, {Vowel: "u"}}, Units: []plan.Unit{
		{Role: "mora", Position: 0, DurationMS: 60},
		{Role: "mora", Position: 1, DurationMS: 200},
		{Role: "mora", Position: 2, DurationMS: 20},
	}}
	// 前のモーラ60msの半分。
	if got := singleCVWorldOverlapMS(p, p.Units[1], 0); got != 30 {
		t.Fatalf("short previous mora: overlap = %.3f, want 30", got)
	}
	// 極端に短くても従来の最小値は保つ。
	if got := singleCVWorldOverlapMS(p, p.Units[2], 0); got != singleCVDefaultVowelOverlapMS {
		t.Fatalf("tiny mora: overlap = %.3f, want %.3f", got, singleCVDefaultVowelOverlapMS)
	}
	// 先行発声は重なりの半分まで引き上げ、子音始まりは変えない。
	unit := p.Units[1]
	unit.OverlapMS = singleCVWorldOverlapMS(p, unit, 0)
	if got := singleCVVowelJoinPreutteranceMS(p, unit); got != 15 {
		t.Fatalf("vowel join preutterance = %.3f, want 15", got)
	}
	cv := &plan.Plan{SingleCV: true, Morae: []frontend.Mora{{Vowel: "a"}, {Consonant: "k", Vowel: "a"}}}
	if got := singleCVVowelJoinPreutteranceMS(cv, plan.Unit{Position: 1, PreutteranceMS: 40, OverlapMS: 100}); got != 40 {
		t.Fatalf("consonant onset preutterance changed to %.3f", got)
	}
}
