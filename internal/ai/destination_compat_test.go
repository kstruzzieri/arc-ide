package ai

import (
	"testing"

	"github.com/kstruzzieri/go-llm/provider"
)

// D10 fixed-point half: for accepted spellings, Firn's canonical form
// rebuilds the SAME destination/v1 identity the raw BaseURL does.
func TestFirnCanonicalEndpointIsADestinationFixedPoint(t *testing.T) {
	accepted := []string{
		"https://api.example.com",
		"https://api.example.com/",
		"https://API.Example.COM/v1/",
		"https://api.example.com:443/v1",
		"http://api.example.com:80",
		"http://api.example.com:8080/path",
		"https://xn--bcher-kva.example/v1",
		"http://192.168.1.20:9000",
		"http://[2001:db8::1]:8080/v1",
		"http://[2001:0db8:0:0:0:0:0:1]:8080/v1",
	}
	for _, raw := range accepted {
		canonical, _, err := NormalizeEndpoint(raw)
		if err != nil {
			t.Fatalf("NormalizeEndpoint(%q): %v", raw, err)
		}
		fromRaw, err := provider.NewDestination("p", raw)
		if err != nil {
			t.Fatalf("NewDestination(raw %q): %v", raw, err)
		}
		fromCanonical, err := provider.NewDestination("p", canonical)
		if err != nil {
			t.Fatalf("NewDestination(canonical %q of %q): %v", canonical, raw, err)
		}
		if fromRaw != fromCanonical {
			t.Fatalf("%q: raw %v != canonical %v", raw, fromRaw, fromCanonical)
		}
	}
}

// D10 rejection-parity half: what upstream refuses, Firn refuses — a
// storable grant is always constructible under destination/v1.
func TestRejectionParityWithDestinationV1(t *testing.T) {
	rejected := []string{
		"https://h/v1/../admin", "https://h/./x", "https://h/v1/%2e%2e/x",
		"https://user:pw@h/v1", "https://h/v1?x=1", "https://h/v1#frag", "ftp://h/v1",
	}
	for _, raw := range rejected {
		if _, _, err := NormalizeEndpoint(raw); err == nil {
			t.Fatalf("NormalizeEndpoint must reject %q", raw)
		}
		if _, err := provider.NewDestination("p", raw); err == nil {
			t.Fatalf("NewDestination must reject %q (parity witness)", raw)
		}
	}
	for _, name := range []string{"bad/name", "ctl\x01", "nl\nx", ""} {
		if _, err := provider.NewDestination(name, "https://h"); err == nil {
			t.Fatalf("NewDestination must reject provider name %q", name)
		}
	}
}

// D10/R3: Firn's canonical form is spelling-independent for IP literals,
// exactly like destination/v1 — one host, one consent digest.
func TestFirnCanonicalCollapsesEquivalentIPLiterals(t *testing.T) {
	pairs := [][2]string{
		{"http://[2001:0db8::1]:8080/v1", "http://[2001:db8::1]:8080/v1"},
		{"http://[2001:0db8:0:0:0:0:0:1]", "http://[2001:db8::1]"},
		{"http://[::FFFF:192.168.1.20]:9000", "http://192.168.1.20:9000"},
	}
	for _, p := range pairs {
		a, _, errA := NormalizeEndpoint(p[0])
		b, _, errB := NormalizeEndpoint(p[1])
		if errA != nil || errB != nil {
			t.Fatalf("%v: %v / %v", p, errA, errB)
		}
		if a != b {
			t.Fatalf("spellings %q and %q must canonicalize identically, got %q vs %q", p[0], p[1], a, b)
		}
		if destinationDigest("p", a) != destinationDigest("p", b) {
			t.Fatal("digests must agree")
		}
	}
}

// An upstream normalization re-version must redden consciously (D10).
func TestDestinationSchemeVersionPinned(t *testing.T) {
	if provider.DestinationSchemeVersion != "destination/v1" {
		t.Fatalf("destination scheme re-versioned to %q: redo the D10 parity analysis and the re-consent reasoning before adapting", provider.DestinationSchemeVersion)
	}
}
