package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTagFilteringDraftsPrereleasesAndSemverOrdering(t *testing.T) {
	var capturedUserAgent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUserAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		// Mix of valid cli-v tags in non-sorted order, draft, prerelease, and non-cli tags
		_, _ = w.Write([]byte(`[
			{"tag_name": "cli-v1.1.0", "draft": false, "prerelease": false, "html_url": "https://example.com/cli-v1.1.0"},
			{"tag_name": "cli-v1.3.0", "draft": false, "prerelease": false, "html_url": "https://example.com/cli-v1.3.0"},
			{"tag_name": "cli-v1.2.0", "draft": false, "prerelease": false, "html_url": "https://example.com/cli-v1.2.0"},
			{"tag_name": "cli-v2.0.0-rc.1", "draft": false, "prerelease": true, "html_url": "https://example.com/cli-v2.0.0-rc.1"},
			{"tag_name": "cli-v3.0.0", "draft": true, "prerelease": false, "html_url": "https://example.com/cli-v3.0.0"},
			{"tag_name": "v1.5.0", "draft": false, "prerelease": false, "html_url": "https://example.com/v1.5.0"},
			{"tag_name": "sdk-v9.0.0", "draft": false, "prerelease": false, "html_url": "https://example.com/sdk-v9.0.0"}
		]`))
	}))
	defer srv.Close()

	info, err := FetchLatestRelease(context.Background(), srv.URL, "1.0.0", srv.Client())
	if err != nil {
		t.Fatalf("FetchLatestRelease failed: %v", err)
	}

	if info.Version != "1.3.0" {
		t.Fatalf("expected version 1.3.0, got %s", info.Version)
	}
	if info.TagName != "cli-v1.3.0" {
		t.Fatalf("expected tag cli-v1.3.0, got %s", info.TagName)
	}
	if !strings.Contains(capturedUserAgent, "signet") {
		t.Fatalf("expected User-Agent to contain signet, got %q", capturedUserAgent)
	}
}

func TestCacheFreshness(t *testing.T) {
	cacheDir := t.TempDir()
	now := time.Now()

	// 1. Fresh cache: server is unreachable, but cache was written within 24h
	freshCache := &Cache{
		CheckedAt: now.Add(-2 * time.Hour),
		Latest:    "1.5.0",
		URL:       "https://example.com/cli-v1.5.0",
	}
	if err := WriteCache(cacheDir, freshCache); err != nil {
		t.Fatalf("WriteCache: %v", err)
	}

	opts := Options{
		ReleasesURL: "http://127.0.0.1:1", // unreachable
		Now:         func() time.Time { return now },
		Executable:  func() (string, error) { return "/usr/local/bin/signet", nil },
	}

	notice, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts)
	if !ok {
		t.Fatalf("expected passive notice from fresh cache, got ok=false")
	}
	if !strings.Contains(notice, "1.0.0 -> 1.5.0") {
		t.Fatalf("notice missing version bump: %s", notice)
	}

	// 2. Expired cache (> 24h old): fetches from server and updates cache
	serverCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverCalled = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"tag_name": "cli-v1.6.0", "draft": false, "prerelease": false, "html_url": "https://example.com/cli-v1.6.0"}
		]`))
	}))
	defer srv.Close()

	expiredCache := &Cache{
		CheckedAt: now.Add(-25 * time.Hour),
		Latest:    "1.5.0",
	}
	if err := WriteCache(cacheDir, expiredCache); err != nil {
		t.Fatalf("WriteCache: %v", err)
	}

	opts.ReleasesURL = srv.URL
	opts.HTTPClient = srv.Client()

	notice, ok = PassiveCheck(context.Background(), "1.0.0", cacheDir, opts)
	if !ok || !serverCalled {
		t.Fatalf("expected server call for expired cache, ok=%v, serverCalled=%v", ok, serverCalled)
	}
	if !strings.Contains(notice, "1.0.0 -> 1.6.0") {
		t.Fatalf("expected notice for 1.6.0, got: %s", notice)
	}

	// Verify updated cache on disk
	updated, err := ReadCache(cacheDir)
	if err != nil {
		t.Fatalf("ReadCache: %v", err)
	}
	if updated.Latest != "1.6.0" {
		t.Fatalf("expected cached latest 1.6.0, got %s", updated.Latest)
	}
}

func TestTimeoutProducesNoNotice(t *testing.T) {
	cacheDir := t.TempDir()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sleep longer than the 2s timeout
		time.Sleep(3 * time.Second)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"tag_name": "cli-v2.0.0", "draft": false, "prerelease": false}]`))
	}))
	defer srv.Close()

	opts := Options{
		ReleasesURL: srv.URL,
		HTTPClient:  srv.Client(),
	}

	notice, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts)
	if ok || notice != "" {
		t.Fatalf("expected timeout to produce no notice, got ok=%v, notice=%q", ok, notice)
	}
}

func TestUpgradeCommandDetection(t *testing.T) {
	npmPath := "/usr/local/lib/node_modules/@signet/cli-linux-x64/bin/signet"
	if cmd := UpgradeCommand(npmPath, "1.5.0"); cmd != "npm install -g @signet/cli@latest" {
		t.Fatalf("expected npm command, got %s", cmd)
	}

	binPath := "/usr/local/bin/signet"
	expectedURL := "https://github.com/blockchain-maxis/signet/releases/tag/cli-v1.5.0"
	if cmd := UpgradeCommand(binPath, "1.5.0"); cmd != expectedURL {
		t.Fatalf("expected URL %s, got %s", expectedURL, cmd)
	}
}

func TestNoticeAtMostOncePerDay(t *testing.T) {
	cacheDir := t.TempDir()
	now := time.Now()
	if err := WriteCache(cacheDir, &Cache{CheckedAt: now.Add(-time.Hour), Latest: "1.5.0"}); err != nil {
		t.Fatalf("WriteCache: %v", err)
	}
	opts := Options{
		Now: func() time.Time { return now },
		Fetch: func(context.Context, string) (*ReleaseInfo, error) {
			t.Fatal("fresh cache must not trigger a lookup")
			return nil, nil
		},
		Executable: func() (string, error) { return "/usr/local/bin/signet", nil },
	}

	if _, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts); !ok {
		t.Fatal("expected the first notice")
	}
	now = now.Add(time.Hour)
	if notice, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts); ok {
		t.Fatalf("second notice within 24h: %q", notice)
	}

	// A day later the notice may show again (after a fresh lookup).
	now = now.Add(CacheInterval)
	opts.Fetch = func(context.Context, string) (*ReleaseInfo, error) {
		return &ReleaseInfo{Version: "1.5.0", TagName: "cli-v1.5.0"}, nil
	}
	if _, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts); !ok {
		t.Fatal("expected the notice again after 24h")
	}
}

func TestFailedLookupIsCached(t *testing.T) {
	cacheDir := t.TempDir()
	now := time.Now()
	calls := 0
	opts := Options{
		Now: func() time.Time { return now },
		Fetch: func(context.Context, string) (*ReleaseInfo, error) {
			calls++
			return nil, context.DeadlineExceeded
		},
	}

	for i := 0; i < 3; i++ {
		if notice, ok := PassiveCheck(context.Background(), "1.0.0", cacheDir, opts); ok {
			t.Fatalf("unexpected notice while offline: %q", notice)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one lookup while offline, got %d", calls)
	}
	c, err := ReadCache(cacheDir)
	if err != nil || !c.Failed {
		t.Fatalf("expected a cached failure, got %+v (%v)", c, err)
	}

	now = now.Add(CacheInterval + time.Minute)
	PassiveCheck(context.Background(), "1.0.0", cacheDir, opts)
	if calls != 2 {
		t.Fatalf("expected a retry after 24h, got %d lookups", calls)
	}
}
