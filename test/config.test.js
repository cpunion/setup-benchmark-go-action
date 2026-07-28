"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Config } = require("../src/config");

test("matches short names and assigns combined and single charts", () => {
  const config = new Config({
    version: 1,
    id: "example",
    groups: {
      core: "^Core",
      parser: { match: "^Parse", chart: "single" },
    },
  });

  assert.equal(
    config.includeBenchmark("BenchmarkCoreRead", "BenchmarkCoreRead"),
    true,
  );
  assert.deepEqual(config.layoutFor("BenchmarkCoreRead", "BenchmarkCoreRead"), {
    group: "core",
    chart: "group:core",
  });
  assert.deepEqual(
    config.layoutFor("BenchmarkParseFile", "pkg::BenchmarkParseFile"),
    { group: "parser", chart: "benchmark:pkg::BenchmarkParseFile" },
  );
  assert.deepEqual(
    config.layoutFor("BenchmarkUngrouped", "BenchmarkUngrouped"),
    { group: "other", chart: "benchmark:BenchmarkUngrouped" },
  );
});

test("rejects overlapping groups and non-RE2 patterns", () => {
  const overlap = new Config({
    id: "overlap",
    groups: { first: "Core", second: "^Core" },
  });
  assert.throws(
    () => overlap.layoutFor("BenchmarkCore", "BenchmarkCore"),
    /matches multiple groups/u,
  );
  assert.throws(
    () => new Config({ id: "lookahead", groups: { bad: "Core(?=Read)" } }),
    /pattern/u,
  );
});

test("include and exclude accept package-qualified short names", () => {
  const config = new Config({
    id: "qualified",
    include: "^example.com/project::Core",
    exclude: "Slow$",
  });
  assert.equal(
    config.includeBenchmark(
      "BenchmarkCoreRead",
      "example.com/project::BenchmarkCoreRead",
    ),
    true,
  );
  assert.equal(
    config.includeBenchmark(
      "BenchmarkCoreSlow",
      "example.com/project::BenchmarkCoreSlow",
    ),
    false,
  );
});
