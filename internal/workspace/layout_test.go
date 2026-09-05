package workspace

import (
	"encoding/json"
	"testing"
)

func boolPtr(v bool) *bool { return &v }

// The #271 fields are additive: a legacy file without them must decode to the
// zero values the frontend normalizer treats as "absent", and a saved
// explicit false for GolemCollapsed must survive a round trip (the default is
// collapsed, so only a pointer can carry "the user opened it").
func TestLayoutRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   Layout
		want string
	}{
		{
			name: "legacy shape emits no #271 keys",
			in:   Layout{PanelSizes: PanelSizes{Left: 260, Right: 280, Bottom: 200}},
			want: `{"panelSizes":{"left":260,"right":280,"bottom":200},"leftCollapsed":false,"rightCollapsed":false,"bottomCollapsed":false}`,
		},
		{
			name: "explicit open golem keeps golemCollapsed:false on the wire",
			in: Layout{
				PanelSizes:     PanelSizes{Left: 260, Right: 280, Bottom: 200, Golem: 512},
				CenterOrder:    "golem-first",
				GolemCollapsed: boolPtr(false),
				FilesCollapsed: true,
			},
			want: `{"panelSizes":{"left":260,"right":280,"bottom":200,"golem":512},"leftCollapsed":false,"rightCollapsed":false,"bottomCollapsed":false,"centerOrder":"golem-first","golemCollapsed":false,"filesCollapsed":true}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(data) != tc.want {
				t.Fatalf("marshal mismatch\n got: %s\nwant: %s", data, tc.want)
			}
			var back Layout
			if err := json.Unmarshal(data, &back); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if back.CenterOrder != tc.in.CenterOrder || back.FilesCollapsed != tc.in.FilesCollapsed ||
				back.PanelSizes != tc.in.PanelSizes {
				t.Fatalf("round trip changed scalar fields: %+v", back)
			}
			if (back.GolemCollapsed == nil) != (tc.in.GolemCollapsed == nil) {
				t.Fatalf("GolemCollapsed presence changed: %v vs %v", back.GolemCollapsed, tc.in.GolemCollapsed)
			}
			if back.GolemCollapsed != nil && *back.GolemCollapsed != *tc.in.GolemCollapsed {
				t.Fatalf("GolemCollapsed value changed")
			}
		})
	}
}

func TestLayoutDecodesLegacyFileWithoutCenterFields(t *testing.T) {
	var l Layout
	if err := json.Unmarshal([]byte(`{"panelSizes":{"left":1,"right":2,"bottom":3},"leftCollapsed":true}`), &l); err != nil {
		t.Fatal(err)
	}
	if l.CenterOrder != "" || l.GolemCollapsed != nil || l.FilesCollapsed || l.PanelSizes.Golem != 0 {
		t.Fatalf("legacy decode must leave #271 fields at zero/nil: %+v", l)
	}
}
