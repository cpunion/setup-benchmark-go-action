package store

import "testing"

func BenchmarkValidateArtifact(b *testing.B) {
	cfg := testConfig(b)
	result := testResult("linux-amd64", "a", 100, 12)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := ValidateResult(&result, cfg); err != nil {
			b.Fatal(err)
		}
	}
}
