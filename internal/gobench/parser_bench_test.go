package gobench

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cpunion/setup-benchmark-go-action/internal/config"
)

func BenchmarkParseGoOutput(b *testing.B) {
	path := filepath.Join(b.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte("id: benchmark\ngroups:\n  core: '^Core'\n"), 0o644); err != nil {
		b.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		b.Fatal(err)
	}
	var output strings.Builder
	output.WriteString("goos: linux\ngoarch: amd64\npkg: example.com/project\n")
	for sample := 0; sample < 5; sample++ {
		for benchmark := 0; benchmark < 20; benchmark++ {
			fmt.Fprintf(&output, "BenchmarkCore%d-2 1000 %d ns/op %d B/op 1 allocs/op\n",
				benchmark, 100+sample, benchmark)
		}
	}
	data := output.String()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Parse(strings.NewReader(data), cfg); err != nil {
			b.Fatal(err)
		}
	}
}
