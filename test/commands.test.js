"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runRecord, runRender } = require("../src/commands");

const sha = "abcdef1234567890abcdef1234567890abcdef12";

test("records and renders without invoking a Go toolchain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-command-"));
  const config = path.join(root, "benchmark.yml");
  const input = path.join(root, "benchmark.txt");
  const artifact = path.join(root, "artifact");
  const output = path.join(root, "record-output");
  fs.writeFileSync(
    config,
    ["version: 1", "id: command", "groups:", "  core: '^Core'", ""].join("\n"),
  );
  fs.writeFileSync(
    input,
    ["goos: linux", "goarch: amd64", "BenchmarkCore-8 10 2 ns/op", ""].join(
      "\n",
    ),
  );
  runRecord([
    "--config",
    config,
    "--input",
    input,
    "--output-dir",
    artifact,
    "--repository",
    "owner/project",
    "--sha",
    sha,
    "--shard-id",
    "language",
    "--github-output",
    output,
  ]);
  assert.match(fs.readFileSync(output, "utf8"), /shard-id=language/u);

  const data = path.join(root, "data");
  const comment = path.join(root, "comment.md");
  runRender([
    "--artifacts",
    artifact,
    "--data-dir",
    data,
    "--series-kind",
    "pull",
    "--series-id",
    "9",
    "--series-label",
    "PR #9",
    "--additional-series-kind",
    "branch",
    "--additional-series-id",
    "feature",
    "--additional-series-label",
    "Branch feature",
    "--comment",
    comment,
  ]);
  assert.match(fs.readFileSync(comment, "utf8"), /No main baseline/u);
  assert.equal(
    fs.existsSync(
      path.join(
        data,
        "go-benchmarks",
        "command",
        "series",
        "branch",
        "feature",
        "history.json",
      ),
    ),
    true,
  );
});

test("records pull request head metadata from the GitHub event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-event-"));
  const config = path.join(root, "benchmark.yml");
  const input = path.join(root, "benchmark.txt");
  const event = path.join(root, "event.json");
  const artifact = path.join(root, "artifact");
  fs.writeFileSync(config, "id: event\n");
  fs.writeFileSync(input, "BenchmarkEvent-8 10 1 ns/op\n");
  fs.writeFileSync(
    event,
    JSON.stringify({
      pull_request: {
        head: {
          ref: "feature",
          sha,
          repo: { full_name: "fork/project" },
        },
      },
    }),
  );
  const previous = process.env.GITHUB_EVENT_PATH;
  process.env.GITHUB_EVENT_PATH = event;
  let recorded;
  try {
    recorded = runRecord(
      ["--config", config, "--input", input, "--output-dir", artifact],
      { githubOutput: "" },
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previous;
  }
  const result = JSON.parse(
    fs.readFileSync(path.join(recorded.outputDirectory, "result.json"), "utf8"),
  );
  assert.equal(result.source.repository, "fork/project");
  assert.equal(result.source.sha, sha);
  assert.equal(result.source.ref, "feature");
});

test("action runtime definitions do not invoke Go", () => {
  const root = path.resolve(__dirname, "..");
  for (const filename of ["action.yml", "publish/action.yml"]) {
    const body = fs.readFileSync(path.join(root, filename), "utf8");
    assert.doesNotMatch(body, /\bgo\s+(run|version|env)\b/u);
    assert.doesNotMatch(body, /setup-go/u);
    assert.match(body, /actions\/github-script@v8/u);
    assert.match(body, /dist\/index\.js/u);
  }
  assert.match(
    fs.readFileSync(path.join(root, "action.yml"), "utf8"),
    /actions\/upload-artifact@v7/u,
  );
});
