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

test("normalizes generic pivot view configuration", () => {
  const config = new Config({
    id: "views",
    views: {
      programs: {
        title: "Program measurements",
        select: {
          groups: "^programs$",
          benchmarks: "^Program/",
        },
        table: {
          rows: ["platform", "benchmark"],
          columns: "metric",
          collapsed: false,
          missing: "error",
          empty: "error",
          "max-rows": 50,
          dimensions: {
            benchmark: {
              title: "Workload",
              "trim-prefix": "BenchmarkProgram/",
            },
          },
          metrics: {
            "binary-bytes": { title: "File size", format: "bytes" },
            "build-ns": { title: "Build", format: "duration-ns" },
          },
        },
      },
    },
  });

  const snapshot = config.toJSON();
  assert.deepEqual(snapshot.views.programs.table.rows, [
    "platform",
    "benchmark",
  ]);
  assert.equal(
    snapshot.views.programs.table.dimensions.benchmark["trim-prefix"],
    "BenchmarkProgram/",
  );
  assert.equal(
    snapshot.views.programs.table.metrics["build-ns"].format,
    "duration-ns",
  );
  assert.deepEqual(new Config(snapshot).toJSON(), snapshot);
});

test("rejects ambiguous or unsupported view layouts", () => {
  assert.throws(
    () =>
      new Config({
        id: "duplicate",
        views: {
          bad: {
            table: {
              rows: ["platform", "metric"],
              columns: ["metric"],
            },
          },
        },
      }),
    /uses dimension metric more than once/u,
  );
  assert.throws(
    () =>
      new Config({
        id: "format",
        views: {
          bad: {
            table: {
              metrics: { "ns/op": { format: "printf-expression" } },
            },
          },
        },
      }),
    /unsupported value/u,
  );
  assert.throws(
    () =>
      new Config({
        id: "selector",
        views: { bad: { select: { benchmarks: "Core(?=Read)" } } },
      }),
    /pattern/u,
  );
});
