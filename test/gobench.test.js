"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Config } = require("../src/config");
const { parseGoBenchmark } = require("../src/gobench");

test("parses standard output, repeated samples, package names, and Unit metadata", () => {
  const config = new Config({
    id: "parser",
    groups: { core: "^Core" },
  });
  const parsed = parseGoBenchmark(
    [
      "goos: linux",
      "goarch: amd64",
      "pkg: example.com/project",
      "Unit widgets/op better=higher assume=exact",
      "BenchmarkCoreRead-8 100 10 ns/op 4 B/op 5 widgets/op",
      "BenchmarkCoreRead-8 100 20 ns/op 8 B/op 7 widgets/op",
      "BenchmarkOther-8 50 2.5 ns/op",
      "PASS",
    ].join("\n"),
    config,
  );

  assert.deepEqual(parsed.fileConfig, {
    goos: "linux",
    goarch: "amd64",
    pkg: "example.com/project",
  });
  assert.deepEqual(parsed.units, {
    "widgets/op": { better: "higher", assume: "exact" },
    "ns/op": { better: "lower" },
    "B/op": { better: "lower" },
  });
  assert.equal(parsed.benchmarks.length, 2);
  assert.deepEqual(parsed.benchmarks[0], {
    name: "BenchmarkCoreRead",
    package: "example.com/project",
    group: "core",
    chart: "group:core",
    samples: [
      {
        iterations: 100,
        measurements: { "ns/op": 10, "B/op": 4, "widgets/op": 5 },
      },
      {
        iterations: 100,
        measurements: { "ns/op": 20, "B/op": 8, "widgets/op": 7 },
      },
    ],
    measurements: { "B/op": 6, "ns/op": 15, "widgets/op": 6 },
  });
  assert.equal(parsed.benchmarks[1].group, "other");
  assert.equal(
    parsed.benchmarks[1].chart,
    "benchmark:example.com/project::BenchmarkOther",
  );
});

test("rejects malformed results and empty included sets", () => {
  const config = new Config({ id: "invalid" });
  assert.throws(
    () => parseGoBenchmark("BenchmarkBad 1 2\n", config),
    /malformed benchmark result/u,
  );
  assert.throws(
    () => parseGoBenchmark("ok example.com/project\n", config),
    /no included Go benchmarks/u,
  );
});
