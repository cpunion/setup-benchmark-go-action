"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Config } = require("../src/config");
const { writeReport } = require("../src/report");
const { update } = require("../src/store");

function result(sha, value) {
  return {
    schemaVersion: 1,
    suiteId: "history",
    shardId: "merged",
    source: {
      repository: "owner/project",
      sha,
      url: `https://github.com/owner/project/commit/${sha}`,
      runUrl: "https://github.com/owner/project/actions/runs/1",
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    platform: {
      id: "linux-amd64",
      label: "Linux / amd64",
      os: "linux",
      arch: "amd64",
    },
    units: { "ns/op": { better: "lower" } },
    benchmarks: [
      {
        name: "BenchmarkCore",
        group: "core",
        chart: "group:core",
        samples: [{ iterations: 10, measurements: { "ns/op": value } }],
        measurements: { "ns/op": value },
      },
    ],
  };
}

test("stores main and pull histories, writes web assets, and reports a baseline", () => {
  const config = new Config({
    id: "history",
    title: "History",
    groups: { core: "^Core" },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-history-"));
  const mainSHA = "1111111111111111111111111111111111111111";
  const pullSHA = "2222222222222222222222222222222222222222";
  update(root, config, { kind: "main", id: "main", label: "Main" }, [
    result(mainSHA, 10),
  ]);
  const updated = update(
    root,
    config,
    { kind: "pull", id: "7", label: "PR #7" },
    [result(pullSHA, 8)],
  );
  const comment = path.join(root, "comment.md");
  writeReport(
    comment,
    "https://owner.github.io/project/go-benchmarks/history/?series=pull%2F7",
    config,
    updated.entry,
    updated.main,
  );

  const body = fs.readFileSync(comment, "utf8");
  assert.match(body, /-20\.0% \(better\)/u);
  assert.match(body, /long-term charts/u);
  assert.equal(
    fs.existsSync(path.join(root, "go-benchmarks", "history", "app.js")),
    true,
  );
  assert.equal(fs.existsSync(path.join(root, ".nojekyll")), true);
  const index = JSON.parse(
    fs.readFileSync(
      path.join(root, "go-benchmarks", "history", "series.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    index.series.map((item) => `${item.kind}/${item.id}`),
    ["main/main", "pull/7"],
  );
});

test("marks values new when no main platform baseline exists", () => {
  const config = new Config({
    id: "history",
    groups: { core: "^Core" },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-new-"));
  const sha = "3333333333333333333333333333333333333333";
  const updated = update(
    root,
    config,
    { kind: "branch", id: "feature", label: "Branch feature" },
    [result(sha, 10)],
  );
  const comment = path.join(root, "comment.md");
  writeReport(comment, "", config, updated.entry, updated.main);
  assert.match(fs.readFileSync(comment, "utf8"), /\| new \|/u);
});

test("keeps valid history when grouping and chart configuration evolves", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-config-"));
  const firstConfig = new Config({
    id: "history",
    groups: { core: "^Core" },
  });
  const secondConfig = new Config({
    id: "history",
    groups: { fast: { match: "^Core", chart: "single" } },
  });
  const first = result("4444444444444444444444444444444444444444", 10);
  update(root, firstConfig, { kind: "main", id: "main", label: "Main" }, [
    first,
  ]);
  const second = result("5555555555555555555555555555555555555555", 9);
  second.benchmarks[0].group = "fast";
  second.benchmarks[0].chart = "benchmark:BenchmarkCore";
  update(root, secondConfig, { kind: "main", id: "main", label: "Main" }, [
    second,
  ]);
  const third = result("6666666666666666666666666666666666666666", 8);
  third.benchmarks[0].group = "fast";
  third.benchmarks[0].chart = "benchmark:BenchmarkCore";
  const updated = update(
    root,
    secondConfig,
    { kind: "main", id: "main", label: "Main" },
    [third],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(updated.historyPath, "utf8")).entries.length,
    3,
  );
});
