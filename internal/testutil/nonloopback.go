// Package testutil holds small test helpers shared across internal packages.
// It must import only the standard library so every internal package can
// depend on it without risking an import cycle.
package testutil

import (
	"net"
	"testing"
)

// ListenNonLoopback binds a listener on the host's first non-loopback IPv4
// address so a stub server is classified REMOTE by go-llm's destination
// admission (classification is lexical: only literal loopback/localhost is
// local) yet is actually reachable from this process. Skips the test when
// the host has no non-loopback IPv4 interface.
func ListenNonLoopback(t testing.TB) (net.Listener, string) {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skip("interfaces unavailable: " + err.Error())
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLoopback() || ipn.IP.To4() == nil {
			continue
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(ipn.IP.String(), "0"))
		if err != nil {
			continue
		}
		t.Cleanup(func() { _ = ln.Close() })
		return ln, "http://" + ln.Addr().String()
	}
	t.Skip("no non-loopback IPv4 interface")
	return nil, ""
}
