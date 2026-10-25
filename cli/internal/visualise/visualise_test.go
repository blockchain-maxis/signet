package visualise

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/dop251/goja"
)

func TestARunawayRenderIsInterrupted(t *testing.T) {
	defer func(old time.Duration) { Limit = old }(Limit)
	Limit = 50 * time.Millisecond
	loop := func() (*goja.Program, error) {
		return goja.Compile("loop.js", "globalThis.signetVisualise = function () { for (;;) {} };", true)
	}
	_, err := render(Input{SpecJSON: json.RawMessage(`{}`), Theme: "auto"}, loop)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("%v", err)
	}
}

func TestADecisionKeepsEveryField(t *testing.T) {
	var d Decision
	if err := json.Unmarshal([]byte(`{"kind":"too-large","nodes":80,"reason":"r"}`), &d); err != nil {
		t.Fatal(err)
	}
	back, _ := json.Marshal(d)
	if d.Kind != "too-large" || string(back) != `{"kind":"too-large","nodes":80,"reason":"r"}` {
		t.Fatalf("%s", back)
	}
}
