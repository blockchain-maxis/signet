// Package update checks whether a newer signet release is available on GitHub
// and manages the once-a-day passive update notification.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/api"
)

const (
	// DefaultReleasesURL is the GitHub API endpoint for releases of the signet repository.
	DefaultReleasesURL = "https://api.github.com/repos/blockchain-maxis/signet/releases?per_page=30"
	// DefaultTimeout is the per-check HTTP timeout for GitHub release lookups.
	DefaultTimeout = 2 * time.Second
	// CacheInterval is the minimum duration between passive update checks.
	CacheInterval = 24 * time.Hour
	// CacheFileName is the name of the update check cache file.
	CacheFileName = "update-check.json"
)

// githubRelease models the subset of fields signet inspects from GitHub's Releases API.
type githubRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	HTMLURL    string `json:"html_url"`
}

// Cache holds the outcome of the last update check and when the passive
// notice was last shown. A failed check is recorded too (Failed), so an
// offline machine waits for the network at most once per CacheInterval.
type Cache struct {
	CheckedAt  time.Time `json:"checked_at"`
	Latest     string    `json:"latest,omitempty"`
	URL        string    `json:"url,omitempty"`
	Failed     bool      `json:"failed,omitempty"`
	NotifiedAt time.Time `json:"notified_at,omitzero"`
}

// Semver represents a 3-component semantic version.
type Semver struct {
	Major int
	Minor int
	Patch int
}

// ParseSemver extracts major, minor, patch from a version string (e.g. "1.2.3", "v1.2.3", "cli-v1.2.3").
func ParseSemver(s string) (Semver, error) {
	s = strings.TrimPrefix(s, "cli-v")
	s = strings.TrimPrefix(s, "v")
	if idx := strings.IndexAny(s, "-+"); idx != -1 {
		s = s[:idx]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return Semver{}, fmt.Errorf("invalid semver: %q", s)
	}
	maj, err1 := strconv.Atoi(parts[0])
	min, err2 := strconv.Atoi(parts[1])
	pat, err3 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return Semver{}, fmt.Errorf("invalid semver numbers in: %q", s)
	}
	return Semver{Major: maj, Minor: min, Patch: pat}, nil
}

// CompareSemver compares two semver strings: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
func CompareSemver(v1, v2 string) (int, error) {
	s1, err := ParseSemver(v1)
	if err != nil {
		return 0, err
	}
	s2, err := ParseSemver(v2)
	if err != nil {
		return 0, err
	}
	if s1.Major != s2.Major {
		if s1.Major > s2.Major {
			return 1, nil
		}
		return -1, nil
	}
	if s1.Minor != s2.Minor {
		if s1.Minor > s2.Minor {
			return 1, nil
		}
		return -1, nil
	}
	if s1.Patch != s2.Patch {
		if s1.Patch > s2.Patch {
			return 1, nil
		}
		return -1, nil
	}
	return 0, nil
}

// IsDevOrPrerelease returns true if v represents a development or prerelease version.
func IsDevOrPrerelease(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || v == "dev" || v == "none" {
		return true
	}
	return strings.Contains(v, "-")
}

// IsNewer reports whether latest is strictly newer than current.
func IsNewer(latest, current string) bool {
	if IsDevOrPrerelease(current) {
		return false
	}
	cmp, err := CompareSemver(latest, current)
	if err != nil {
		return false
	}
	return cmp > 0
}

// UpgradeCommand returns the recommended upgrade instruction based on executable location.
func UpgradeCommand(exePath, latestVersion string) string {
	slash := filepath.ToSlash(exePath)
	if strings.Contains(slash, "/node_modules/@signet/cli-") || strings.Contains(slash, "node_modules/@signet/cli-") {
		return "npm install -g @signet/cli@latest"
	}
	return fmt.Sprintf("https://github.com/blockchain-maxis/signet/releases/tag/cli-v%s", latestVersion)
}

// ReleaseInfo encapsulates metadata for a discovered release.
type ReleaseInfo struct {
	Version string
	TagName string
	URL     string
}

// Options allows overriding network or environment parameters for testing.
type Options struct {
	ReleasesURL string
	HTTPClient  *http.Client
	CacheDir    string
	Now         func() time.Time
	Executable  func() (string, error)
	// Fetch replaces the GitHub lookup (tests use it to stay off the
	// network). When nil, FetchLatestRelease is called with ReleasesURL and
	// HTTPClient.
	Fetch func(ctx context.Context, currentVersion string) (*ReleaseInfo, error)
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o Options) executable() string {
	var exe string
	if o.Executable != nil {
		exe, _ = o.Executable()
	} else {
		exe, _ = os.Executable()
	}
	return exe
}

func (o Options) fetch(ctx context.Context, currentVersion string) (*ReleaseInfo, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()
	if o.Fetch != nil {
		return o.Fetch(fetchCtx, currentVersion)
	}
	return FetchLatestRelease(fetchCtx, o.ReleasesURL, currentVersion, o.HTTPClient)
}

// FetchLatestRelease queries the GitHub releases endpoint and finds the latest cli-v* release.
func FetchLatestRelease(ctx context.Context, releasesURL string, currentVersion string, client *http.Client) (*ReleaseInfo, error) {
	if releasesURL == "" {
		releasesURL = DefaultReleasesURL
	}
	if client == nil {
		client = &http.Client{Timeout: DefaultTimeout}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", api.UserAgent(currentVersion))
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from releases API", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var releases []githubRelease
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, err
	}

	var best *ReleaseInfo
	for _, r := range releases {
		if r.Draft || r.Prerelease {
			continue
		}
		if !strings.HasPrefix(r.TagName, "cli-v") {
			continue
		}
		v := strings.TrimPrefix(r.TagName, "cli-v")
		if _, err := ParseSemver(v); err != nil {
			continue
		}
		if best == nil {
			best = &ReleaseInfo{Version: v, TagName: r.TagName, URL: r.HTMLURL}
		} else {
			cmp, err := CompareSemver(v, best.Version)
			if err == nil && cmp > 0 {
				best = &ReleaseInfo{Version: v, TagName: r.TagName, URL: r.HTMLURL}
			}
		}
	}

	if best == nil {
		return nil, errors.New("no valid cli releases found")
	}
	return best, nil
}

// CachePath returns the full path to update-check.json in dir.
func CachePath(dir string) string {
	return filepath.Join(dir, CacheFileName)
}

// ReadCache reads the update check cache from dir.
func ReadCache(dir string) (*Cache, error) {
	p := CachePath(dir)
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var c Cache
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// WriteCache persists the update check cache to dir.
func WriteCache(dir string, c *Cache) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(CachePath(dir), data, 0o644)
}

// CheckResult represents the outcome of an update check.
type CheckResult struct {
	Current         string
	Latest          string
	UpdateAvailable bool
	UpgradeCommand  string
	Err             error
}

// Check performs an on-demand update check. A successful lookup refreshes the
// cache (keeping when the passive notice was last shown).
func Check(ctx context.Context, currentVersion string, opts Options) (*CheckResult, error) {
	rel, err := opts.fetch(ctx, currentVersion)
	if err != nil {
		return nil, err
	}

	if opts.CacheDir != "" {
		next := &Cache{CheckedAt: opts.now(), Latest: rel.Version, URL: rel.URL}
		if prev, err := ReadCache(opts.CacheDir); err == nil {
			next.NotifiedAt = prev.NotifiedAt
		}
		_ = WriteCache(opts.CacheDir, next)
	}

	return &CheckResult{
		Current:         currentVersion,
		Latest:          rel.Version,
		UpdateAvailable: IsNewer(rel.Version, currentVersion),
		UpgradeCommand:  UpgradeCommand(opts.executable(), rel.Version),
	}, nil
}

// PassiveCheck decides whether to show the passive update notice, and returns
// it. It looks the latest release up at most once per CacheInterval, caching
// a failed lookup as well as a successful one, and returns a notice at most
// once per CacheInterval; showing one is recorded in the cache.
func PassiveCheck(ctx context.Context, currentVersion string, cacheDir string, opts Options) (string, bool) {
	if IsDevOrPrerelease(currentVersion) {
		return "", false
	}
	now := opts.now()

	c, err := ReadCache(cacheDir)
	if err != nil {
		c = nil
	}
	if c == nil || now.Sub(c.CheckedAt) >= CacheInterval || c.CheckedAt.After(now) {
		next := &Cache{CheckedAt: now}
		if c != nil {
			next.NotifiedAt = c.NotifiedAt
		}
		rel, err := opts.fetch(ctx, currentVersion)
		if err != nil {
			next.Failed = true
			if c != nil {
				next.Latest, next.URL = c.Latest, c.URL
			}
		} else {
			next.Latest, next.URL = rel.Version, rel.URL
		}
		_ = WriteCache(cacheDir, next)
		c = next
	}

	if c.Latest == "" || !IsNewer(c.Latest, currentVersion) {
		return "", false
	}
	if !c.NotifiedAt.IsZero() && now.Sub(c.NotifiedAt) < CacheInterval && !c.NotifiedAt.After(now) {
		return "", false
	}
	c.NotifiedAt = now
	if err := WriteCache(cacheDir, c); err != nil {
		// Without a record of having shown it, the notice would repeat on
		// every command; stay quiet instead.
		return "", false
	}

	upgradeCmd := UpgradeCommand(opts.executable(), c.Latest)
	notice := fmt.Sprintf("\nA new release of signet is available: %s -> %s\nTo upgrade: %s\n", currentVersion, c.Latest, upgradeCmd)
	return notice, true
}
