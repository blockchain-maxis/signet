package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// doctorDeployment answers /api/v1/health (or only /api/health when legacy),
// as a deployment would, with the knobs a doctor check reads.
type doctorDeployment struct {
	status     int    // the health check's HTTP status
	pairing    string // up, down, skipped
	passphrase string
	legacy     bool          // no /api/v1: only /api/health
	skew       time.Duration // the deployment's clock, minus this machine's
}

func (f doctorDeployment) serve(t *testing.T, now time.Time) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", now.Add(f.skew).UTC().Format(http.TimeFormat))
		health := map[string]any{
			"status": map[bool]string{true: "ok", false: "degraded"}[f.pairing != "down"],
			"checks": map[string]any{"db": "up", "registry": map[bool]string{true: "up", false: "down"}[f.pairing != "down"], "pairing": f.pairing},
		}
		switch {
		case r.URL.Path == "/api/v1/health" && !f.legacy:
			health["apiVersion"] = "1"
			health["networkPassphrase"] = f.passphrase
			w.WriteHeader(f.status)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": health})
		case r.URL.Path == "/api/health" && f.legacy:
			w.WriteHeader(f.status)
			_ = json.NewEncoder(w).Encode(health)
		case r.URL.Path == "/.well-known/stellar.toml" && f.legacy:
			_, _ = w.Write([]byte("NETWORK_PASSPHRASE=\"" + f.passphrase + "\"\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

var healthy = doctorDeployment{status: 200, pairing: "up", passphrase: testnetPassphrase}

// runDoctorCmd runs `signet doctor --json` with the fake stellar on PATH
// holding identities, against deployment, after setup.
func runDoctorCmd(t *testing.T, identities string, deployment doctorDeployment, setup func(t *testing.T)) (map[string]doctorCheck, error) {
	t.Helper()
	isolateDirs(t)
	buildFakeStellarOnPath(t)
	t.Setenv("FAKESTELLAR_IDENTITIES", identities)
	now := time.Date(2026, 10, 26, 9, 0, 0, 0, time.UTC)
	url := deployment.serve(t, now)
	if setup != nil {
		setup(t)
	}
	deps := defaultDeps()
	deps.KeysBinary = "stellar"
	deps.Now = func() time.Time { return now }
	root := newRootCmdWithDeps("1.2.3", "abc1234", deps)
	stdout := &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"doctor", "--json", "--url", url, "--network", "testnet"})
	err := root.Execute()
	var got doctorResult
	if jerr := json.Unmarshal(stdout.Bytes(), &got); jerr != nil {
		t.Fatalf("not one JSON object: %v\n%s", jerr, stdout)
	}
	byName := map[string]doctorCheck{}
	for _, c := range got.Checks {
		byName[c.Name] = c
	}
	return byName, err
}

func TestDoctorChecksEachThingInIsolation(t *testing.T) {
	writeConfig := func(raw string) func(t *testing.T) {
		return func(t *testing.T) {
			path, err := config.Path()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(strings.TrimSuffix(path, "/config.json"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, tc := range []struct {
		name       string
		identities string
		deployment doctorDeployment
		setup      func(t *testing.T)
		check      string
		status     string
		detail     string
	}{
		{name: "all green", identities: "alice", deployment: healthy},
		{name: "no identities", deployment: healthy, check: "identities", status: statusFail, detail: "no stellar identities"},
		{name: "a config file that does not parse", identities: "alice", deployment: healthy, setup: writeConfig("{not json"), check: "config file", status: statusFail, detail: "does not parse"},
		{name: "a current context that does not exist", identities: "alice", deployment: healthy,
			setup: writeConfig(`{"version":2,"current":"gone","contexts":{"work":{"network":"testnet"}}}`), check: "config file", status: statusFail, detail: `the current context "gone" does not exist`},
		{name: "a deployment with no database", identities: "alice", deployment: doctorDeployment{status: 503, pairing: "down", passphrase: testnetPassphrase}, check: "deployment", status: statusFail, detail: "answers 503"},
		{name: "a deployment that cannot pair", identities: "alice", deployment: doctorDeployment{status: 200, pairing: "down", passphrase: testnetPassphrase}, check: "deployment", status: statusFail, detail: "cannot link wallets"},
		{name: "a deployment on another network", identities: "alice", deployment: doctorDeployment{status: 200, pairing: "up", passphrase: "Public Global Stellar Network ; September 2015"}, check: "network", status: statusFail, detail: "serves mainnet"},
		{name: "a legacy deployment's network from its stellar.toml", identities: "alice", deployment: doctorDeployment{status: 200, pairing: "up", passphrase: "Public Global Stellar Network ; September 2015", legacy: true}, check: "network", status: statusFail, detail: "serves mainnet"},
		{name: "a clock a minute off", identities: "alice", deployment: doctorDeployment{status: 200, pairing: "up", passphrase: testnetPassphrase, skew: -time.Minute}, check: "clock", status: statusWarn, detail: "1m0s ahead of the deployment's"},
		{name: "a clock five minutes off", identities: "alice", deployment: doctorDeployment{status: 200, pairing: "up", passphrase: testnetPassphrase, skew: 5 * time.Minute}, check: "clock", status: statusFail, detail: "5m0s behind the deployment's"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checks, err := runDoctorCmd(t, tc.identities, tc.deployment, tc.setup)
			failing := 0
			for name, c := range checks {
				if name == tc.check {
					if c.Status != tc.status || !strings.Contains(c.Detail, tc.detail) {
						t.Fatalf("%s: %+v", name, c)
					}
					if c.Status == statusFail && c.Fix == "" && name != "network" && name != "config file" {
						t.Errorf("%s fails with no fix", name)
					}
				} else if c.Status != statusOK {
					t.Errorf("%s is %s (%s), but only %q should be off", name, c.Status, c.Detail, tc.check)
				}
				if c.Status == statusFail {
					failing++
				}
			}
			want := exitcode.OK
			if failing > 0 {
				want = exitcode.Configuration
			}
			if code := ExitCode(err); code != want {
				t.Fatalf("exit %d (%v), want %d", code, err, want)
			}
			if len(checks) != 7 {
				t.Fatalf("%d checks: %v", len(checks), checks)
			}
		})
	}
}

func TestDoctorNeverPrintsTheHomeDirectory(t *testing.T) {
	checks, _ := runDoctorCmd(t, "alice", healthy, func(t *testing.T) {
		path, _ := config.Path()
		_ = os.MkdirAll(strings.TrimSuffix(path, "/config.json"), 0o700)
		_ = os.WriteFile(path, []byte("{oops"), 0o600)
	})
	home, _ := os.UserHomeDir()
	for _, c := range checks {
		if strings.Contains(c.Detail+c.Fix, home) {
			t.Fatalf("%s mentions %s: %+v", c.Name, home, c)
		}
	}
}
