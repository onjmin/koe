package voicebank

import (
	"math"

	"utautts/internal/acoustic"
	"utautts/internal/audio"
	"utautts/internal/oto"
	"utautts/internal/pitch"
)

const (
	candidatePitchGuardMS   = 5.0
	candidatePitchWindowMS  = 150.0
	candidatePitchMinimumMS = 30.0
)

type candidatePitchKey struct {
	filename string
	offset   float64
	fixed    float64
	blank    float64
}

type candidatePitch struct {
	Hz    float64
	Valid bool
}

// measureCandidateF0は診断用に母音領域の中央値F0を推定する。
func measureCandidateF0(entry oto.Entry, cache map[candidatePitchKey]candidatePitch) candidatePitch {
	if entry.Filename == "" {
		return candidatePitch{}
	}
	key := candidatePitchKey{filename: entry.Filename, offset: entry.Offset, fixed: entry.Fixed, blank: entry.Blank}
	if result, ok := cache[key]; ok {
		return result
	}
	result := candidatePitch{}
	pcm, err := audio.ReadWav(entry.Filename)
	if err != nil || pcm.SampleRate <= 0 || pcm.Channels <= 0 {
		cache[key] = result
		return result
	}
	trimmed, err := audio.TrimPCM(pcm, entry.Offset, entry.Blank)
	if err != nil {
		cache[key] = result
		return result
	}
	values := acoustic.Mono(trimmed)
	start := pitchFrames(math.Max(0, entry.Fixed)+candidatePitchGuardMS, trimmed.SampleRate)
	end := min(len(values), start+pitchFrames(candidatePitchWindowMS, trimmed.SampleRate))
	if start < 0 || start >= end || end-start < pitchFrames(candidatePitchMinimumMS, trimmed.SampleRate) {
		cache[key] = result
		return result
	}
	result.Hz = pitch.EstimateMedian(values[start:end], trimmed.SampleRate)
	result.Valid = result.Hz > 0
	cache[key] = result
	return result
}

func pitchFrames(milliseconds float64, sampleRate int) int {
	if milliseconds <= 0 || sampleRate <= 0 {
		return 0
	}
	return int(math.Round(milliseconds * float64(sampleRate) / 1000))
}
