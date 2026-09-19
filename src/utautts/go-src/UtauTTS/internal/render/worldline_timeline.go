package render

import (
	"errors"
	"fmt"
	"math"

	"utautts/internal/plan"
)

// WorldlineTimelineConfigはBuildWorldlineTimelineの入力。
// renderWorldlineEngineがbridgeへ渡すmanifestを組み立てるときと同じ規則で
// ユニット配置とF0曲線を計算するが、波形生成は行わない。
type WorldlineTimelineConfig struct {
	ReleaseMS             float64
	LeadingPreutteranceMS float64
	ApplyPitch            bool
	IntonationStrength    float64
	PitchCurve            *PitchCurve
	// SourcePitchesはplan.Unitsと同じ順のユニット収録ピッチ(Hz)。0や欠損は基準値で補う。
	SourcePitches       []float64
	CVVCTiming          string
	CVVCTransitionGain  float64
	CVVCPreBoundaryFade bool
	MixMode             string
	ExactLength         bool
}

// WorldlineEnvelopePointはOpenUTAU互換のエンベロープ点(ノート開始基準ms, ゲイン)。
type WorldlineEnvelopePoint struct {
	XMS float64 `json:"x_ms"`
	Y   float64 `json:"y"`
}

// WorldlineTimelineUnitは1ユニットのworldline PhraseSynthへの配置。
// PositionMS/SkipMS/LengthMS/FadeInMS/FadeOutMSはAddRequestの引数、
// OffsetMS/RequiredLengthMS/ConsonantMS/CutoffMS/Tone/ConsonantVelocity/VolumeはSynthRequestの値。
type WorldlineTimelineUnit struct {
	Index             int                      `json:"index"`
	Position          int                      `json:"position"`
	Role              string                   `json:"role"`
	Mora              string                   `json:"mora"`
	Alias             string                   `json:"alias"`
	NoteStartMS       float64                  `json:"note_start_ms"`
	DurationMS        float64                  `json:"duration_ms"`
	PositionMS        float64                  `json:"position_ms"`
	SkipMS            float64                  `json:"skip_ms"`
	LengthMS          float64                  `json:"length_ms"`
	FadeInMS          float64                  `json:"fade_in_ms"`
	FadeOutMS         float64                  `json:"fade_out_ms"`
	OffsetMS          float64                  `json:"offset_ms"`
	RequiredLengthMS  float64                  `json:"required_length_ms"`
	ConsonantMS       float64                  `json:"consonant_ms"`
	CutoffMS          float64                  `json:"cutoff_ms"`
	Tone              int                      `json:"tone"`
	ConsonantVelocity float64                  `json:"consonant_velocity"`
	Volume            float64                  `json:"volume"`
	EnergyFactor      float64                  `json:"energy_factor"`
	SourceF0Hz        float64                  `json:"source_f0_hz"`
	TargetF0Hz        float64                  `json:"target_f0_hz"`
	Envelope          []WorldlineEnvelopePoint `json:"envelope,omitempty"`
}

// WorldlineTimelineはフレーズ全体の配置。時刻0はLeadingMSだけ先行した位置で、
// 計画上の時刻tはタイムライン上の t+LeadingMS に対応する。
type WorldlineTimeline struct {
	FrameMS     float64                 `json:"frame_ms"`
	LeadingMS   float64                 `json:"leading_ms"`
	DurationMS  float64                 `json:"duration_ms"`
	ReferenceHz float64                 `json:"reference_hz"`
	F0Curve     []float64               `json:"f0_curve"`
	Units       []WorldlineTimelineUnit `json:"units"`
}

// BuildWorldlineTimelineはrenderWorldlineEngineと同じ規則で各ユニットの配置とF0曲線を求める。
// 音源ファイルを読まないため、収録ピッチは呼び出し側がSourcePitchesで渡す。
// 診断情報(TimingScale, Effective*, SourceF0Hz, TargetF0Hz, IntonationFactor)はplanへ書き戻す。
func BuildWorldlineTimeline(synthesisPlan *plan.Plan, cfg WorldlineTimelineConfig) (*WorldlineTimeline, error) {
	if synthesisPlan == nil || len(synthesisPlan.Units) == 0 {
		return nil, errors.New("empty synthesis plan")
	}
	if cfg.CVVCTiming == "" {
		cfg.CVVCTiming = CVVCTimingSequential
	}
	if cfg.CVVCTiming != CVVCTimingSequential {
		return nil, fmt.Errorf("unknown CVVC timing mode %q", cfg.CVVCTiming)
	}
	if cfg.CVVCTransitionGain == 0 {
		cfg.CVVCTransitionGain = 1
	}
	if cfg.CVVCTransitionGain < 0 || cfg.CVVCTransitionGain > 1 {
		return nil, fmt.Errorf("CVVC transition gain must be between 0 and 1; got %.3f", cfg.CVVCTransitionGain)
	}
	if cfg.ReleaseMS < 0 || math.IsNaN(cfg.ReleaseMS) || math.IsInf(cfg.ReleaseMS, 0) {
		return nil, fmt.Errorf("release_ms must be non-negative, got %v", cfg.ReleaseMS)
	}
	synthesisPlan.CVVCTiming = cfg.CVVCTiming
	synthesisPlan.CVVCTransitionGain = cfg.CVVCTransitionGain
	synthesisPlan.CVVCPreBoundaryFade = cfg.CVVCPreBoundaryFade
	if _, err := worldlineLegacyMix(synthesisPlan, cfg.MixMode); err != nil {
		return nil, err
	}

	units := synthesisPlan.Units
	timings := make([]effectiveTiming, len(units))
	phoneUnits := worldlinePhoneTimingUnits(synthesisPlan, cfg.ReleaseMS)
	if synthesisPlan.SingleCV {
		for index := range phoneUnits {
			if phoneUnits[index].Silent || phoneUnits[index].Role != "mora" {
				continue
			}
			phoneUnits[index].OverlapMS = singleCVWorldOverlapMS(synthesisPlan, phoneUnits[index], phoneUnits[index].PreutteranceMS)
		}
	}
	phoneTimings, phraseStartMS := openUtauPhoneTimingsWithCoda(phoneUnits, cfg.CVVCTiming, true)
	leadingMS := limitLeadingPreutterance(math.Max(0, -phraseStartMS), cfg.LeadingPreutteranceMS)
	synthesisPlan.LeadingMarginMS = leadingMS
	for i := range units {
		unit := &units[i]
		vcvUnit := unit.Role == "mora" && isVCVUnit(*unit)
		vcvSpeech := vcvUnit && synthesisPlan.SpeechTiming
		timings[i] = worldlineTiming(synthesisPlan, *unit, cfg.ReleaseMS)
		if len(phoneTimings) == len(units) && !unit.Silent {
			timings[i].preutteranceMS = phoneTimings[i].preutter
			timings[i].overlapMS = phoneTimings[i].overlap
			if unit.Role != "mora" || (!synthesisPlan.SingleCV && (!vcvUnit || !vcvSpeech)) {
				timings[i].consonantMS = unit.ConsonantMS
				timings[i].scale = 1
			}
		}
		unit.TimingScale = timings[i].scale
		unit.EffectivePreutteranceMS = timings[i].preutteranceMS
		unit.EffectiveConsonantMS = timings[i].consonantMS
		unit.EffectiveOverlapMS = timings[i].overlapMS
		unit.CVTimingApplied = timings[i].cvApplied
		unit.CVTimingWarnings = append([]string(nil), timings[i].cvWarnings...)
		unit.IntonationFactor = 1
	}

	// measureWorldlinePitchesと同じ扱い: 無音・遷移ユニットは0、その後安定化する。
	pitches := make([]float64, len(units))
	for i, unit := range units {
		if unit.Silent || unit.Role == "transition" || i >= len(cfg.SourcePitches) {
			continue
		}
		value := cfg.SourcePitches[i]
		if value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			pitches[i] = value
		}
	}
	if synthesisPlan.SingleCV {
		pitches = stabilizeSingleCVPitches(synthesisPlan, pitches)
	} else {
		pitches = stabilizeWorldlinePitches(pitches)
	}
	intonation := identityFactors(len(units))
	if cfg.ApplyPitch {
		intonation = analyzeIntonationFromPitches(synthesisPlan, timings, pitches, cfg.IntonationStrength)
	}
	reference := medianFloat(nonzeroFloats(pitches))
	if reference <= 0 {
		reference = 220
	}
	pitchFactors := make([]float64, len(units))
	for i, unit := range units {
		pitchFactors[i] = intonation[i] * effectiveUnitPitchFactor(unit, cfg.ApplyPitch)
	}

	frameMS := worldlineFrameMS
	curveStartMS := -leadingMS
	curveDurationMS := synthesisPlan.DurationMS + cfg.ReleaseMS + leadingMS
	f0Curve := worldlineF0CurveAtOffset(synthesisPlan, pitches, pitchFactors, reference,
		max(2, int(math.Ceil(curveDurationMS/frameMS))+2), frameMS, curveStartMS)
	for frame := range f0Curve {
		f0Curve[frame] *= pitchCurveFactorAt(cfg.PitchCurve, curveStartMS+float64(frame)*frameMS)
	}
	result := &WorldlineTimeline{
		FrameMS:     frameMS,
		LeadingMS:   leadingMS,
		DurationMS:  curveDurationMS,
		ReferenceHz: reference,
		F0Curve:     f0Curve,
	}

	for i := range units {
		unit := &units[i]
		if unit.Silent {
			continue
		}
		timing := timings[i]
		unitPitch := pitches[i]
		if unitPitch <= 0 {
			unitPitch = reference
		}
		unit.SourceF0Hz = pitches[i]
		unit.TargetF0Hz = unitPitch * pitchFactors[i] * pitchCurveFactorAt(cfg.PitchCurve, unit.NoteStartMS)
		unit.IntonationFactor = intonation[i]

		singleCVUnit := synthesisPlan.SingleCV && unit.Role == "mora"
		vcvUnit := unit.Role == "mora" && isVCVUnit(*unit)
		vcvSpeech := vcvUnit && synthesisPlan.SpeechTiming
		volume := 100.0
		if unit.Role == "transition" {
			volume *= cfg.CVVCTransitionGain
		}
		if unit.ResamplerVolumeOverride {
			volume = float64(unit.ResamplerVolume)
		}

		// OpenUTAUと同じ位置からbendを始め、先頭の余剰をskipする。
		pitchLeadingMS := unit.PreutteranceMS
		if singleCVUnit || vcvSpeech {
			pitchLeadingMS = phoneTimings[i].preutter
		}
		phoneTiming := phoneTimings[i]
		skipMS := math.Max(0, pitchLeadingMS-phoneTiming.preutter)
		durCorrection := phoneTiming.preutter - phoneTiming.tailIntrude + phoneTiming.tailOverlap
		envelopePoints := openUtauEnvelopeFromTiming(*unit, phoneTiming)
		if cfg.CVVCPreBoundaryFade && unit.Role == "transition" {
			envelopePoints = cvvcPreBoundaryEnvelope(envelopePoints, phoneTiming)
		}
		if synthesisPlan.WordBoundaryEnvelope {
			envelopePoints, unit.BoundaryEnvelope = wordBoundaryEnvelope(synthesisPlan, *unit, envelopePoints)
		}
		positionMS := unit.NoteStartMS - phoneTiming.preutter + leadingMS
		consonantLength := unit.ConsonantMS
		if singleCVUnit || vcvSpeech {
			consonantLength = timing.consonantMS
		}
		requiredLength := math.Max(unit.DurationMS+durCorrection+skipMS, consonantLength)
		requiredLength = math.Ceil(requiredLength/50+0.5) * 50
		if cfg.ExactLength {
			requiredLength = unit.DurationMS
		}
		lengthMS := timing.preutteranceMS + unit.DurationMS + cfg.ReleaseMS
		if positionMS < 0 {
			leadingTrimMS := -positionMS
			skipMS += leadingTrimMS
			lengthMS -= leadingTrimMS
			positionMS = 0
		}
		fadeInMS := math.Max(2, timing.preutteranceMS-timing.overlapMS)
		fadeOutMS := cfg.ReleaseMS
		if len(envelopePoints) == 5 {
			lengthMS = envelopePoints[4].XMS - envelopePoints[0].XMS
			fadeInMS = envelopePoints[1].XMS - envelopePoints[0].XMS
			fadeOutMS = envelopePoints[4].XMS - envelopePoints[3].XMS
		}
		if worldCodaReleaseEligible(synthesisPlan, *unit) {
			envelopePoints, fadeOutMS = codaReleaseEnvelope(*unit, envelopePoints, fadeOutMS)
		}
		envelope := make([]WorldlineEnvelopePoint, len(envelopePoints))
		for index, point := range envelopePoints {
			envelope[index] = WorldlineEnvelopePoint{XMS: point.XMS, Y: point.Y}
		}
		result.Units = append(result.Units, WorldlineTimelineUnit{
			Index:             i,
			Position:          unit.Position,
			Role:              unit.Role,
			Mora:              unit.Mora,
			Alias:             unit.Alias,
			NoteStartMS:       unit.NoteStartMS,
			DurationMS:        unit.DurationMS,
			PositionMS:        positionMS,
			SkipMS:            skipMS,
			LengthMS:          lengthMS,
			FadeInMS:          fadeInMS,
			FadeOutMS:         fadeOutMS,
			OffsetMS:          unit.OffsetMS,
			RequiredLengthMS:  requiredLength,
			ConsonantMS:       unit.ConsonantMS,
			CutoffMS:          unit.CutoffMS,
			Tone:              int(math.Round(69 + 12*math.Log2(unitPitch/440))),
			ConsonantVelocity: 100,
			Volume:            volume,
			EnergyFactor:      unit.EnergyFactor,
			SourceF0Hz:        pitches[i],
			TargetF0Hz:        unit.TargetF0Hz,
			Envelope:          envelope,
		})
	}
	return result, nil
}
