package pitch

import (
	"math"
	"testing"
)

func TestEstimateMedianSine(t *testing.T) {
	const sampleRate = 16000
	wave := make([]float64, sampleRate/2)
	for i := range wave {
		wave[i] = 0.2 * math.Sin(2*math.Pi*220*float64(i)/sampleRate)
	}
	got := EstimateMedian(wave, sampleRate)
	if math.Abs(got-220) > 3 {
		t.Fatalf("EstimateMedian() = %.2f, want about 220", got)
	}
}

func TestEstimateRejectsDCSignal(t *testing.T) {
	wave := make([]float64, 640)
	for i := range wave {
		wave[i] = 0.3
	}
	if got := Estimate(wave, 16000); got != 0 {
		t.Fatalf("Estimate() = %.2f for a DC signal, want 0", got)
	}
}
