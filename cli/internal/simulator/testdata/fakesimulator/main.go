// Command fakesimulator stands in for signet-simulator in
// internal/simulator's tests. It speaks the NDJSON protocol of
// docs/CLI_RUST_BRIDGE.md in one of two ways:
//
//   - FAKESIM_TRANSCRIPT=<file>: replay a sandbox/protocol/transcripts file.
//     Each line Go writes must match the transcript's next Go line (ignoring
//     its id); the simulator lines that follow are written back with the id
//     rewritten to the one Go used.
//   - otherwise: a small stateful simulator. It keeps contracts and
//     checkpoints, and `simulate` behaves according to its function name:
//     hang, crash, panic, fetch, fail, slow; anything else succeeds.
//
// Other knobs, all environment variables:
//
//	FAKESIM_FIRST_LINE   written instead of the hello_ack (raw)
//	FAKESIM_EXIT_EARLY   exit with this code before the handshake
//	FAKESIM_IGNORE_TERM  ignore SIGTERM (and log that it arrived)
//	FAKESIM_LANES        the ledger protocols hello_ack reports, comma separated (default 28)
//	FAKESIM_LOG          append "<pid> <line>" for every line read
//	FAKESIM_VERSION      the release `--version` reports
//	FAKESIM_SCRIPT       a JSON file of {"<type>": {"fetch": [keys], "reply": {...}}}:
//	                     a request of that type first asks Go for the keys
//	                     with ledger_fetch, then answers with the reply
//	                     (type "result" unless it says otherwise)
package main

import (
	"bufio"
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var (
	pid     = os.Getpid()
	logFile *os.File
	out     = bufio.NewWriter(os.Stdout)
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		v := os.Getenv("FAKESIM_VERSION")
		if v == "" {
			v = "0.0.0-fake"
		}
		fmt.Printf("signet-simulator %s (commit fake) protocol 1 lanes 28\n", v)
		return
	}
	if path := os.Getenv("FAKESIM_LOG"); path != "" {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			fatal("open log: %v", err)
		}
		logFile = f
	}
	if os.Getenv("FAKESIM_IGNORE_TERM") != "" {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM)
		go func() {
			for range ch {
				logLine("SIGTERM")
			}
		}()
	}
	if code := os.Getenv("FAKESIM_EXIT_EARLY"); code != "" {
		fmt.Fprintln(os.Stderr, "fakesimulator: exiting before the handshake")
		n, _ := strconv.Atoi(code)
		os.Exit(n)
	}

	lines := make(chan []byte, 64)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 80<<20)
		for sc.Scan() {
			b := append([]byte(nil), sc.Bytes()...)
			logLine(string(b))
			lines <- b
		}
		close(lines)
	}()

	if path := os.Getenv("FAKESIM_TRANSCRIPT"); path != "" {
		replay(path, lines)
		return
	}
	serve(lines)
}

// ---- transcript replay ----

// fromGo reports whether a transcript line is one Go writes.
func fromGo(typ string) bool {
	switch typ {
	case "hello_ack", "result", "error", "contract_error", "ledger_fetch":
		return false
	}
	return true
}

func replay(path string, lines <-chan []byte) {
	raw, err := os.ReadFile(path)
	if err != nil {
		fatal("read transcript: %v", err)
	}
	var script []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			fatal("transcript line is not JSON: %s", l)
		}
		script = append(script, m)
	}

	i := 0
	for i < len(script) {
		want := script[i]
		if !fromGo(str(want["type"])) {
			fatal("transcript line %d is a simulator line where a Go line was expected", i+1)
		}
		got, ok := next(lines, str(want["type"]))
		if !ok {
			os.Exit(0)
		}
		if !sameExceptID(want, got) {
			fatal("transcript line %d: want %v, got %v", i+1, want, got)
		}
		wantID, gotID := want["id"], got["id"]
		i++
		lastPanic := false
		for i < len(script) && !fromGo(str(script[i]["type"])) {
			m := script[i]
			if m["id"] == wantID {
				m["id"] = gotID
			}
			lastPanic = m["id"] == nil
			emit(m)
			i++
		}
		if lastPanic {
			os.Exit(101)
		}
	}
}

// next returns the next line Go wrote, skipping answers to ledger_fetch the
// transcript does not wait for.
func next(lines <-chan []byte, wantType string) (map[string]any, bool) {
	for b := range lines {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			fatal("Go wrote a line that is not JSON: %s", b)
		}
		typ := str(m["type"])
		if typ != wantType && (typ == "ledger_entries" || typ == "error") && strings.HasPrefix(str(m["id"]), "sim-") {
			continue
		}
		return m, true
	}
	return nil, false
}

func sameExceptID(a, b map[string]any) bool {
	ca, cb := map[string]any{}, map[string]any{}
	for k, v := range a {
		if k != "id" {
			ca[k] = v
		}
	}
	for k, v := range b {
		if k != "id" {
			cb[k] = v
		}
	}
	return reflect.DeepEqual(ca, cb)
}

// ---- stateful mode ----

type state struct {
	contracts   map[string]string // id -> wasm hash
	checkpoints map[string]bool
	cpCount     int
	entries     int
}

// scripted is one FAKESIM_SCRIPT step.
type scripted struct {
	Fetch []string       `json:"fetch"`
	Reply map[string]any `json:"reply"`
}

func loadScript() map[string]scripted {
	path := os.Getenv("FAKESIM_SCRIPT")
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		fatal("read script: %v", err)
	}
	var script map[string]scripted
	if err := json.Unmarshal(raw, &script); err != nil {
		fatal("script is not JSON: %v", err)
	}
	return script
}

func runScript(id any, step scripted, lines <-chan []byte) {
	if len(step.Fetch) > 0 {
		keys := make([]any, len(step.Fetch))
		for i, k := range step.Fetch {
			keys[i] = k
		}
		emit(map[string]any{"version": 1, "id": "sim-1", "type": "ledger_fetch", "keys_xdr": keys})
		answer, ok := <-lines
		if !ok {
			os.Exit(0)
		}
		var m map[string]any
		_ = json.Unmarshal(answer, &m)
		if str(m["type"]) == "error" {
			detail, _ := m["detail"].(map[string]any)
			emit(errMsg(id, "fetch_failed", str(detail["kind"]), str(m["message"])))
			return
		}
	}
	reply := map[string]any{"version": 1, "id": id, "type": "result"}
	for k, v := range step.Reply {
		reply[k] = v
	}
	emit(reply)
}

func serve(lines <-chan []byte) {
	st := &state{contracts: map[string]string{}, checkpoints: map[string]bool{}}
	script := loadScript()
	greeted := false
	for b := range lines {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			emit(errMsg(nil, "bad_request", "invalid_json", "not JSON"))
			continue
		}
		id, typ := m["id"], str(m["type"])
		if !greeted {
			greeted = true
			if first := os.Getenv("FAKESIM_FIRST_LINE"); first != "" {
				fmt.Fprintln(out, first)
				out.Flush()
				continue
			}
			lanes := []any{}
			for _, p := range strings.Split(cmp.Or(os.Getenv("FAKESIM_LANES"), "28"), ",") {
				n, _ := strconv.Atoi(strings.TrimSpace(p))
				lanes = append(lanes, map[string]any{"ledger_protocol": n, "env_host": p + ".0.2", "simulation": p + ".0.2"})
			}
			emit(map[string]any{
				"version": 1, "id": id, "type": "hello_ack", "server_protocol_version": 1,
				"simulator_version": "0.0.0-fake", "commit": "fake",
				"lanes": lanes,
			})
			continue
		}
		if step, ok := script[typ]; ok {
			runScript(id, step, lines)
			continue
		}
		switch typ {
		case "shutdown":
			emit(result(id, nil))
			os.Exit(0)
		case "ledger_open":
			*st = state{contracts: map[string]string{}, checkpoints: map[string]bool{}}
			emit(result(id, map[string]any{"ledger_protocol": 28, "sequence": 1}))
		case "ledger_put":
			n := len(m["entries"].([]any))
			st.entries += n
			emit(result(id, map[string]any{"written": n}))
		case "contract_install":
			cid := str(m["contract_id"])
			if cid == "" {
				cid = fmt.Sprintf("CFAKE%d", len(st.contracts)+1)
			}
			st.contracts[cid] = strings.Repeat("a", 64)
			emit(result(id, map[string]any{"contract_id": cid, "wasm_hash": st.contracts[cid]}))
		case "contract_swap":
			emit(result(id, map[string]any{"contract_id": str(m["contract_id"]), "wasm_hash": str(m["wasm_hash"])}))
		case "ledger_checkpoint":
			// Ids differ per process, so a replay must translate them.
			st.cpCount++
			cp := fmt.Sprintf("cp-%d-%d", pid, st.cpCount)
			st.checkpoints[cp] = true
			emit(result(id, map[string]any{"checkpoint": cp}))
		case "ledger_rollback":
			cp := str(m["checkpoint"])
			if !st.checkpoints[cp] {
				emit(errMsg(id, "bad_request", "invalid_field", "unknown checkpoint "+cp))
				continue
			}
			emit(result(id, nil))
		case "status":
			emit(result(id, map[string]any{
				"uptime_ms": 1, "ledger_open": true, "ledger_sequence": 1,
				"entries": st.entries, "contracts": len(st.contracts),
			}))
		case "simulate":
			simulate(id, str(m["function"]), m, lines)
		default:
			emit(errMsg(id, "bad_request", "unknown_type", "unknown message type `"+typ+"`"))
		}
	}
}

func simulate(id any, fn string, m map[string]any, lines <-chan []byte) {
	ok := map[string]any{
		"return_value_xdr": "AAAAAwAAAAE=", "events": []any{},
		"cost": map[string]any{"cpu_insns": 1, "mem_bytes": 1}, "logs": []any{},
	}
	switch fn {
	case "hang":
		select {}
	case "crash":
		for i := 1; i <= 60; i++ {
			fmt.Fprintf(os.Stderr, "panic line %d\n", i)
		}
		os.Exit(3)
	case "panic":
		emit(errMsg(nil, "internal_panic", "panic", "index out of bounds"))
		os.Exit(101)
	case "fail":
		emit(map[string]any{
			"version": 1, "id": id, "type": "contract_error", "kind": "contract",
			"code": "Error(Contract, #2)", "message": "handle already claimed", "diagnostic_events": []any{},
		})
	case "fetch":
		keys := []any{"AAAABgAAAAE="}
		emit(map[string]any{"version": 1, "id": "sim-1", "type": "ledger_fetch", "keys_xdr": keys})
		b, okRead := <-lines
		if !okRead {
			os.Exit(0)
		}
		var ans map[string]any
		_ = json.Unmarshal(b, &ans)
		if ans["id"] != "sim-1" {
			fatal("expected the answer to sim-1, got %s", b)
		}
		if str(ans["type"]) == "error" {
			detail, _ := ans["detail"].(map[string]any)
			emit(errMsg(id, "fetch_failed", str(detail["kind"]), str(ans["message"])))
			return
		}
		entries := ans["entries"].([]any)
		first := entries[0].(map[string]any)
		ok["return_value_xdr"] = first["entry_xdr"]
		emit(result(id, ok))
	case "slow":
		time.Sleep(30 * time.Millisecond)
		if len(lines) > 0 {
			// Another request arrived while this one was running: the
			// client failed to serialise.
			emit(errMsg(id, "bad_request", "overlap", "a request arrived while another was in flight"))
			return
		}
		emit(result(id, ok))
	default:
		emit(result(id, ok))
	}
}

// ---- helpers ----

func result(id any, fields map[string]any) map[string]any {
	m := map[string]any{"version": 1, "id": id, "type": "result"}
	for k, v := range fields {
		m[k] = v
	}
	return m
}

func errMsg(id any, code, kind, message string) map[string]any {
	return map[string]any{
		"version": 1, "id": id, "type": "error", "code": code, "message": message,
		"detail": map[string]any{"kind": kind},
	}
}

func emit(m map[string]any) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // keep <commit> and <version> findable
	if err := enc.Encode(m); err != nil {
		fatal("marshal: %v", err)
	}
	s := strings.NewReplacer("<commit>", "fake", "<version>", "0.0.0-fake").Replace(buf.String())
	fmt.Fprint(out, s)
	out.Flush()
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func logLine(s string) {
	if logFile != nil {
		fmt.Fprintf(logFile, "%d %s\n", pid, s)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "fakesimulator: "+format+"\n", args...)
	os.Exit(2)
}
