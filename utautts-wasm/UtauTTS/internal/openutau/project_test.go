package openutau

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInspectProjectExtractsRendererProvenance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sample.ustx")
	data := "\ufeffname: Test\nustx_version: \"0.9\"\nresolution: 480\nbpm: 120\nexpressions:\n  vel:\n    default_value: 100\n  mod:\n    default_value: 0\ntracks:\n- singer: Voice\n  phonemizer: Japanese\n  renderer_settings:\n    renderer: CLASSIC\n    resampler: worldline\n    wavtool: convergence\n  track_name: Main\nvoice_parts: []\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	audit, err := InspectProject(path)
	if err != nil {
		t.Fatal(err)
	}
	if audit.Name != "Test" || audit.USTXVersion != "0.9" || audit.Resolution != 480 || audit.BPM != 120 {
		t.Fatalf("unexpected project metadata: %+v", audit)
	}
	if audit.ExpressionDefaults["vel"] != 100 || audit.ExpressionDefaults["mod"] != 0 {
		t.Fatalf("unexpected expression defaults: %+v", audit.ExpressionDefaults)
	}
	if len(audit.Tracks) != 1 {
		t.Fatalf("got %d tracks", len(audit.Tracks))
	}
	track := audit.Tracks[0]
	if track.Renderer != "CLASSIC" || track.Resampler != "worldline" || track.Wavtool != "convergence" || track.Singer != "Voice" {
		t.Fatalf("unexpected track: %+v", track)
	}
}
