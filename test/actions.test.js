"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { run: runRecordAction } = require("../src/record-action");
const { run: runRenderAction } = require("../src/render-action");

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("record action adapter maps inputs to a validated artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-action-"));
  const config = path.join(root, "benchmark.yml");
  const benchmark = path.join(root, "benchmark.txt");
  fs.writeFileSync(config, "id: action\n");
  fs.writeFileSync(
    benchmark,
    "goos: linux\ngoarch: amd64\nBenchmarkAction-8 10 1 ns/op\n",
  );
  const recorded = withEnvironment(
    {
      BENCHMARK_CONFIG: config,
      BENCHMARK_BENCHMARK_FILE: benchmark,
      BENCHMARK_SHARD_ID: "unit",
      GITHUB_REPOSITORY: "owner/project",
      GITHUB_SHA: "7777777777777777777777777777777777777777",
    },
    runRecordAction,
  );

  assert.equal(recorded.outputs["platform-id"], "linux-amd64");
  assert.equal(recorded.outputs["shard-id"], "unit");
  assert.equal(
    recorded.outputs["artifact-name"],
    "go-benchmark-action-linux-amd64-unit",
  );
  assert.equal(
    fs.existsSync(path.join(recorded.outputDirectory, "result.json")),
    true,
  );
});

test("render action adapter writes history and publisher outputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-render-"));
  const artifacts = path.join(root, "artifacts");
  fs.mkdirSync(artifacts);
  fs.writeFileSync(
    path.join(artifacts, "config.json"),
    JSON.stringify({
      version: 1,
      id: "render",
      title: "Render",
      sitePath: "go-benchmarks/render",
      include: ["^Benchmark"],
      exclude: [],
      maxBenchmarks: 500,
      groups: {},
    }),
  );
  fs.writeFileSync(
    path.join(artifacts, "result.json"),
    JSON.stringify({
      schemaVersion: 1,
      suiteId: "render",
      shardId: "unit",
      source: {
        repository: "owner/project",
        sha: "8888888888888888888888888888888888888888",
        url: "https://github.com/owner/project/commit/8888888888888888888888888888888888888888",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
      platform: { id: "linux-amd64", label: "Linux / amd64" },
      units: { "ns/op": { better: "lower" } },
      benchmarks: [
        {
          name: "BenchmarkRender",
          group: "other",
          chart: "benchmark:BenchmarkRender",
          samples: [{ iterations: 10, measurements: { "ns/op": 1 } }],
          measurements: { "ns/op": 1 },
        },
      ],
    }),
  );
  const rendered = withEnvironment(
    {
      BENCHMARK_ARTIFACTS: artifacts,
      BENCHMARK_DATA_DIRECTORY: path.join(root, "data"),
      BENCHMARK_SERIES_KIND: "main",
      BENCHMARK_SERIES_ID: "main",
      BENCHMARK_SERIES_LABEL: "Main",
      BENCHMARK_SITE_BASE_URL: "https://owner.github.io/project",
      BENCHMARK_COMMENT_PATH: path.join(root, "comment.md"),
    },
    runRenderAction,
  );
  assert.equal(rendered.outputs["suite-id"], "render");
  assert.match(rendered.outputs["site-url"], /series=main%2Fmain/u);
  assert.equal(fs.existsSync(rendered.outputs["comment-path"]), true);
});
