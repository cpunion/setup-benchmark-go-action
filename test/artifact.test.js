"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Config } = require("../src/config");
const {
  loadArtifacts,
  mergeShards,
  validateResult,
  writeArtifact,
} = require("../src/artifact");

const sha = "1234567890abcdef1234567890abcdef12345678";

function benchmark(name) {
  return {
    name,
    group: "core",
    chart: "group:core",
    samples: [{ iterations: 10, measurements: { "ns/op": 2 } }],
    measurements: { "ns/op": 2 },
  };
}

function result(shardId, names, overrides = {}) {
  return {
    schemaVersion: 1,
    suiteId: "artifact",
    shardId,
    source: {
      repository: "owner/project",
      sha,
      url: `https://github.com/owner/project/commit/${sha}`,
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    platform: {
      id: "linux-amd64",
      label: "Linux / amd64",
      os: "linux",
      arch: "amd64",
    },
    units: { "ns/op": { better: "lower" } },
    benchmarks: names.map(benchmark),
    ...overrides,
  };
}

test("validates, writes, loads, and merges distinct shards", () => {
  const config = new Config({
    id: "artifact",
    groups: { core: "^Core" },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-artifact-"));
  writeArtifact(
    path.join(root, "first"),
    config,
    result("first", ["BenchmarkCoreA"]),
  );
  writeArtifact(
    path.join(root, "second"),
    config,
    result("second", ["BenchmarkCoreB"]),
  );

  const loaded = loadArtifacts(root);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].shardId, "merged");
  assert.deepEqual(
    loaded.results[0].benchmarks.map((item) => item.name),
    ["BenchmarkCoreA", "BenchmarkCoreB"],
  );
});

test("rejects duplicate shards, benchmarks, and source SHAs", () => {
  const first = result("first", ["BenchmarkCoreA"]);
  assert.throws(
    () => mergeShards([first, JSON.parse(JSON.stringify(first))]),
    /duplicate shard/u,
  );
  assert.throws(
    () => mergeShards([first, result("second", ["BenchmarkCoreA"])]),
    /repeats benchmark/u,
  );
  assert.throws(
    () =>
      mergeShards([
        first,
        result("second", ["BenchmarkCoreB"], {
          source: {
            ...first.source,
            sha: "abcdef1234567890abcdef1234567890abcdef12",
          },
        }),
      ]),
    /source does not match/u,
  );
});

test("rejects metadata and platform conflicts between shards", () => {
  const first = result("first", ["BenchmarkCoreA"]);
  const metadata = result("second", ["BenchmarkCoreB"]);
  metadata.units["ns/op"].better = "higher";
  assert.throws(() => mergeShards([first, metadata]), /conflicting metadata/u);

  const platform = result("second", ["BenchmarkCoreB"]);
  platform.platform.label = "Different";
  assert.throws(
    () => mergeShards([first, platform]),
    /metadata differs between shards/u,
  );
});

test("rejects summaries that are not sample medians", () => {
  const config = new Config({
    id: "artifact",
    groups: { core: "^Core" },
  });
  const invalid = result("first", ["BenchmarkCoreA"]);
  invalid.benchmarks[0].measurements["ns/op"] = 3;
  assert.throws(
    () => validateResult(invalid, config),
    /summary is not the sample median/u,
  );
});
