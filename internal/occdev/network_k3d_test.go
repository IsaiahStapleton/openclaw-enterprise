package occdev

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The k3d network probe target must carry the same ordinary profile that Compute's
// allow-gateway-ingress selects, or dev-up's actual=true probe can never be admitted.
func TestDevelopmentGatewayProbeLabelsCarryComputeNetworkProfile(t *testing.T) {
	labels := developmentGatewayProbeLabels()
	if labels["openclaw.dev/workload-role"] != "gateway" {
		t.Fatalf("probe target workload role = %q, want gateway", labels["openclaw.dev/workload-role"])
	}
	source, err := os.ReadFile(filepath.Join("..", "..", "apps", "controller", "src", "drivers", "compute", "kubernetes", "resources", "network.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`NETWORK_PROFILE_LABEL = "` + networkProfileLabel + `"`,
		`ORDINARY_NETWORK_PROFILE = "` + ordinaryNetworkProfile + `"`,
	} {
		if !strings.Contains(string(source), want) {
			t.Fatalf("Compute network.ts no longer declares %s", want)
		}
	}
	if labels[networkProfileLabel] != ordinaryNetworkProfile {
		t.Fatalf("probe target network profile = %q, want %q", labels[networkProfileLabel], ordinaryNetworkProfile)
	}
	labels[networkProfileLabel] = "mutated"
	if developmentGatewayProbeLabels()[networkProfileLabel] != ordinaryNetworkProfile {
		t.Fatal("probe labels must be freshly allocated")
	}
}
