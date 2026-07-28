package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cpunion/setup-benchmark-go-action/internal/config"
	"github.com/cpunion/setup-benchmark-go-action/internal/model"
)

func TestUpdateFirstPullRequest(t *testing.T) {
	cfg := testConfig(t)
	root := t.TempDir()
	result := testResult("linux-amd64", "a", 100, 12)
	updated, err := Update(root, cfg, SeriesSpec{Kind: "pull", ID: "12", Label: "PR #12"}, []model.Result{result})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Main != nil {
		t.Fatalf("first pull request baseline = %+v, want nil", updated.Main)
	}
	for _, path := range []string{
		filepath.Join(root, ".nojekyll"),
		filepath.Join(updated.SitePath, "series.json"),
		filepath.Join(updated.SitePath, "series", "pull", "12", "history.json"),
		filepath.Join(updated.SitePath, "series", "pull", "12", "config.json"),
		filepath.Join(updated.SitePath, "index.html"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("generated %s: %v", path, err)
		}
	}
}

func TestUpdateUsesLatestMatchingMainPlatform(t *testing.T) {
	cfg := testConfig(t)
	root := t.TempDir()
	main := SeriesSpec{Kind: "main", ID: "main", Label: "Main"}
	if _, err := Update(root, cfg, main, []model.Result{
		testResult("linux-amd64", "a", 100, 10),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(root, cfg, main, []model.Result{
		testResult("darwin-arm64", "b", 200, 20),
	}); err != nil {
		t.Fatal(err)
	}
	updated, err := Update(root, cfg, SeriesSpec{Kind: "pull", ID: "2", Label: "PR #2"}, []model.Result{
		testResult("linux-amd64", "c", 300, 11),
		testResult("darwin-arm64", "c", 300, 21),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Main == nil || len(updated.Main.Platforms) != 2 {
		t.Fatalf("matching main baseline = %+v", updated.Main)
	}
	if got := updated.Main.Platforms["linux-amd64"].Benchmarks[0].Measurements["ns/op"]; got != 10 {
		t.Fatalf("linux baseline = %v, want 10", got)
	}
	if got := updated.Main.Platforms["darwin-arm64"].Benchmarks[0].Measurements["ns/op"]; got != 20 {
		t.Fatalf("darwin baseline = %v, want 20", got)
	}
}

func TestValidateResultRejectsUnsafeArtifact(t *testing.T) {
	cfg := testConfig(t)
	result := testResult("linux-amd64", "a", 100, 1)
	result.Benchmarks[0].Package = "bad|table"
	if err := ValidateResult(&result, cfg); err == nil || !strings.Contains(err.Error(), "invalid package") {
		t.Fatalf("ValidateResult error = %v", err)
	}
	result = testResult("linux-amd64", "a", 100, 1)
	result.Source.URL = "javascript:alert(1)"
	if err := ValidateResult(&result, cfg); err == nil || !strings.Contains(err.Error(), "source URL") {
		t.Fatalf("ValidateResult URL error = %v", err)
	}
}

func testConfig(t testing.TB) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte("id: sample\ngroups:\n  core: '^BenchmarkCore'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func testResult(platform, shaByte string, timestamp int64, value float64) model.Result {
	sha := strings.Repeat(shaByte, 40)
	return model.Result{
		SchemaVersion: model.SchemaVersion,
		SuiteID:       "sample",
		Source: model.Source{
			Repository: "owner/project",
			SHA:        sha,
			URL:        "https://github.com/owner/project/commit/" + sha,
			Timestamp:  time.Unix(timestamp, 0).UTC(),
		},
		Platform: model.Platform{ID: platform, Label: platform},
		Benchmarks: []model.Benchmark{{
			Name:  "BenchmarkCore",
			Group: "core",
			Samples: []model.Sample{{
				Iterations:   10,
				Measurements: map[string]float64{"ns/op": value},
			}},
			Measurements: map[string]float64{"ns/op": value},
		}},
	}
}
