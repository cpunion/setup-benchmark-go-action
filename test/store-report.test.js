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

test("uses history written before comment views as a matching baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-old-view-"));
  const original = new Config({
    id: "history",
    groups: { core: "^Core" },
  });
  const withView = new Config({
    id: "history",
    groups: { core: "^Core" },
    views: {
      core: {
        select: { groups: "^core$" },
        table: {
          rows: ["platform", "benchmark"],
          columns: ["metric"],
        },
      },
    },
  });
  update(root, original, { kind: "main", id: "main", label: "Main" }, [
    result("7777777777777777777777777777777777777777", 10),
  ]);
  const updated = update(
    root,
    withView,
    { kind: "pull", id: "8", label: "PR #8" },
    [result("8888888888888888888888888888888888888888", 9)],
  );
  const comment = path.join(root, "comment.md");
  writeReport(comment, "", withView, updated.entry, updated.main);
  const body = fs.readFileSync(comment, "utf8");
  assert.match(body, /\| Linux \/ amd64 \| BenchmarkCore \| 9 ns\/op/u);
  assert.match(body, /-10\.0% \(better\)/u);
});

function viewPlatform(id, label, sha, program, core) {
  return {
    schemaVersion: 1,
    suiteId: "views",
    shardId: "merged",
    source: {
      repository: "owner/project",
      sha,
      url: `https://github.com/owner/project/commit/${sha}`,
      runUrl: "https://github.com/owner/project/actions/runs/2",
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    platform: { id, label },
    units: {
      "binary-bytes": { better: "lower", assume: "exact" },
      "build-ns": { better: "lower" },
      "run-ns": { better: "lower" },
      "ns/op": { better: "lower" },
    },
    benchmarks: [
      {
        name: "BenchmarkProgram/cprintf",
        group: "programs",
        chart: "group:programs",
        samples: [{ iterations: 1, measurements: program }],
        measurements: program,
      },
      {
        name: "BenchmarkDirectCall",
        group: "core",
        chart: "group:core",
        samples: [{ iterations: 100, measurements: { "ns/op": core } }],
        measurements: { "ns/op": core },
      },
    ],
  };
}

function viewEntry(sha, values) {
  return {
    source: {
      repository: "owner/project",
      sha,
      url: `https://github.com/owner/project/commit/${sha}`,
      runUrl: "https://github.com/owner/project/actions/runs/2",
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    platforms: Object.fromEntries(
      values.map((value) => [
        value.id,
        viewPlatform(value.id, value.label, sha, value.program, value.core),
      ]),
    ),
  };
}

test("renders selected measurements as generic pivot and collapsed tables", () => {
  const config = new Config({
    id: "views",
    title: "View report",
    groups: {
      programs: "^Program/",
      core: "^Direct",
    },
    views: {
      programs: {
        title: "Program measurements",
        select: { groups: "^programs$" },
        table: {
          rows: ["platform", "benchmark"],
          columns: ["metric"],
          missing: "error",
          dimensions: {
            benchmark: {
              title: "Workload",
              "trim-prefix": "BenchmarkProgram/",
            },
          },
          metrics: {
            "binary-bytes": { title: "File size", format: "bytes" },
            "build-ns": { title: "Build", format: "duration-ns" },
            "run-ns": { title: "Run", format: "duration-ns" },
          },
        },
      },
      core: {
        title: "Core language benchmarks",
        select: { groups: "^core$" },
        table: {
          rows: ["platform", "benchmark"],
          columns: ["metric"],
          collapsed: true,
        },
      },
    },
  });
  const mainSHA = "9999999999999999999999999999999999999999";
  const pullSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const main = viewEntry(mainSHA, [
    {
      id: "linux-amd64",
      label: "Linux",
      program: {
        "binary-bytes": 18_000,
        "build-ns": 400_000_000,
        "run-ns": 1_000_000,
      },
      core: 2,
    },
    {
      id: "darwin-arm64",
      label: "macOS",
      program: {
        "binary-bytes": 80_000,
        "build-ns": 500_000_000,
        "run-ns": 2_000_000,
      },
      core: 1,
    },
  ]);
  const current = viewEntry(pullSHA, [
    {
      id: "linux-amd64",
      label: "Linux",
      program: {
        "binary-bytes": 18_264,
        "build-ns": 354_926_000,
        "run-ns": 1_274_000,
      },
      core: 1.5,
    },
    {
      id: "darwin-arm64",
      label: "macOS",
      program: {
        "binary-bytes": 84_752,
        "build-ns": 440_208_000,
        "run-ns": 4_072_000,
      },
      core: 0.9,
    },
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-views-"));
  const comment = path.join(root, "comment.md");
  writeReport(comment, "https://example.test/charts", config, current, main);
  const body = fs.readFileSync(comment, "utf8");

  assert.match(
    body,
    /\| Platform \| Workload \| File size \| vs main \| Build \| vs main \| Run \| vs main \|/u,
  );
  assert.match(
    body,
    /\| Linux \| cprintf \| 18264 B \| \+1\.5% \(worse\) \| 354\.926 ms \| -11\.3% \(better\) \| 1\.274 ms \| \+27\.4% \(worse\) \|/u,
  );
  assert.match(body, /<summary>Core language benchmarks<\/summary>/u);
  assert.match(body, /\| macOS \| BenchmarkDirectCall \| 0\.900 ns\/op/u);
});

test("supports split dimensions and enforces pivot cell completeness", () => {
  const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const current = viewEntry(sha, [
    {
      id: "linux-amd64",
      label: "Linux",
      program: {
        "binary-bytes": 18_264,
        "build-ns": 354_926_000,
        "run-ns": 1_274_000,
      },
      core: 1.5,
    },
    {
      id: "darwin-arm64",
      label: "macOS",
      program: {
        "binary-bytes": 84_752,
        "build-ns": 440_208_000,
        "run-ns": 4_072_000,
      },
      core: 0.9,
    },
  ]);
  const split = new Config({
    id: "views",
    groups: { programs: "^Program/", core: "^Direct" },
    views: {
      programs: {
        select: { groups: "^programs$" },
        table: {
          rows: ["benchmark"],
          columns: ["metric"],
          "split-by": ["platform"],
          missing: "error",
        },
      },
    },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-split-"));
  const comment = path.join(root, "comment.md");
  writeReport(comment, "", split, current, null);
  const body = fs.readFileSync(comment, "utf8");
  assert.match(body, /#### Platform: Linux/u);
  assert.match(body, /#### Platform: macOS/u);
  assert.match(body, /\| new \|/u);
  assert.match(
    body,
    /No main baseline exists yet; all metrics are marked `new`/u,
  );

  const ambiguous = new Config({
    id: "views",
    groups: { programs: "^Program/", core: "^Direct" },
    views: {
      programs: {
        select: { groups: "^programs$" },
        table: { rows: ["benchmark"], columns: ["metric"] },
      },
    },
  });
  assert.throws(
    () =>
      writeReport(
        path.join(root, "ambiguous.md"),
        "",
        ambiguous,
        current,
        null,
      ),
    /duplicate cell/u,
  );

  const incomplete = JSON.parse(JSON.stringify(current));
  delete incomplete.platforms["linux-amd64"].benchmarks[0].measurements[
    "run-ns"
  ];
  const strict = new Config({
    id: "views",
    groups: { programs: "^Program/", core: "^Direct" },
    views: {
      programs: {
        select: { groups: "^programs$" },
        table: {
          rows: ["platform", "benchmark"],
          columns: ["metric"],
          missing: "error",
        },
      },
    },
  });
  assert.throws(
    () =>
      writeReport(
        path.join(root, "incomplete.md"),
        "",
        strict,
        incomplete,
        null,
      ),
    /missing cell/u,
  );
});
