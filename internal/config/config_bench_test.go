package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func BenchmarkGroupRules(b *testing.B) {
	var body string
	for i := 0; i < 8; i++ {
		body += fmt.Sprintf("  group%d: '^Group%d'\n", i, i)
	}
	path := filepath.Join(b.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte("id: benchmark\ngroups:\n"+body), 0o644); err != nil {
		b.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		b.Fatal(err)
	}
	names := make([]string, 8)
	keys := make([]string, 8)
	for i := range names {
		names[i] = fmt.Sprintf("BenchmarkGroup%dOperation", i)
		keys[i] = "example.com/project::" + names[i]
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		index := i % len(names)
		if _, err := cfg.GroupFor(names[index], keys[index]); err != nil {
			b.Fatal(err)
		}
	}
}
