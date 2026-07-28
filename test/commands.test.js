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
    "--trusted-config",
    config,
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
    "--expected-source-repository",
    "owner/project",
    "--expected-source-sha",
    sha,
    "--source-ref",
    "feature",
    "--source-url",
    `https://github.com/owner/project/commit/${sha}`,
    "--source-run-url",
    "https://github.com/owner/project/actions/runs/123",
    "--source-timestamp",
    "2026-07-28T12:00:00.000Z",
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
  const history = JSON.parse(
    fs.readFileSync(
      path.join(
        data,
        "go-benchmarks",
        "command",
        "series",
        "pull",
        "9",
        "history.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(history.entries[0].source, {
    repository: "owner/project",
    sha,
    ref: "feature",
    url: `https://github.com/owner/project/commit/${sha}`,
    runUrl: "https://github.com/owner/project/actions/runs/123",
    timestamp: "2026-07-28T12:00:00.000Z",
  });

  assert.throws(
    () =>
      runRender([
        "--artifacts",
        artifact,
        "--data-dir",
        path.join(root, "rejected"),
        "--series-kind",
        "pull",
        "--series-id",
        "9",
        "--series-label",
        "PR #9",
        "--expected-source-repository",
        "another/project",
        "--expected-source-sha",
        sha,
      ]),
    /artifact source repository .* does not match/u,
  );
  assert.throws(
    () =>
      runRender([
        "--artifacts",
        artifact,
        "--data-dir",
        path.join(root, "rejected-sha"),
        "--series-kind",
        "pull",
        "--series-id",
        "9",
        "--series-label",
        "PR #9",
        "--expected-source-repository",
        "owner/project",
        "--expected-source-sha",
        "0000000000000000000000000000000000000000",
      ]),
    /artifact source SHA .* does not match/u,
  );
  assert.throws(
    () =>
      runRender([
        "--artifacts",
        artifact,
        "--data-dir",
        path.join(root, "rejected-partial-source"),
        "--series-kind",
        "pull",
        "--series-id",
        "9",
        "--series-label",
        "PR #9",
        "--expected-source-repository",
        "owner/project",
      ]),
    /repository and SHA must be provided together/u,
  );
  const changedConfig = path.join(root, "changed-benchmark.yml");
  fs.writeFileSync(changedConfig, "id: command\ntitle: Changed\n");
  assert.throws(
    () =>
      runRender([
        "--artifacts",
        artifact,
        "--data-dir",
        path.join(root, "rejected-config"),
        "--trusted-config",
        changedConfig,
        "--series-kind",
        "pull",
        "--series-id",
        "9",
        "--series-label",
        "PR #9",
      ]),
    /artifact configuration does not match/u,
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
