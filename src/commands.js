"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { loadArtifacts, writeArtifact, schemaVersion } = require("./artifact");
const { loadConfig } = require("./config");
const { parseGoBenchmark } = require("./gobench");
const { writeReport } = require("./report");
const { update } = require("./store");
const { assert, safePart, writeOutputs } = require("./util");

function options(args, definitions) {
  const parsed = parseArgs({
    args,
    options: Object.fromEntries(
      Object.keys(definitions).map((name) => [name, { type: "string" }]),
    ),
    strict: true,
  });
  return parsed.values;
}

function required(values, names, command) {
  for (const name of names) {
    assert(values[name], `${command} requires --${name}`);
  }
}

function goOS() {
  return { win32: "windows" }[process.platform] ?? process.platform;
}

function goArch() {
  return { x64: "amd64", ia32: "386" }[process.arch] ?? process.arch;
}

function displayOS(value) {
  return (
    { darwin: "macOS", linux: "Linux", windows: "Windows" }[value] ?? value
  );
}

function githubEvent() {
  const filename = process.env.GITHUB_EVENT_PATH;
  if (!filename) return {};
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`read GitHub event ${filename}: ${error.message}`, {
      cause: error,
    });
  }
}

function sourceDefaults() {
  const event = githubEvent();
  const head = event.pull_request?.head;
  return {
    repository: head?.repo?.full_name || process.env.GITHUB_REPOSITORY || "",
    sha: head?.sha || process.env.GITHUB_SHA || "",
    ref:
      head?.ref ||
      process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF_NAME ||
      process.env.GITHUB_REF ||
      "",
  };
}

function serverURL() {
  return (process.env.GITHUB_SERVER_URL || "https://github.com").replace(
    /\/+$/u,
    "",
  );
}

function defaultSourceURL(repository, sha) {
  return `${serverURL()}/${repository}/commit/${sha}`;
}

function defaultRunURL() {
  return process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `${serverURL()}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";
}

function defaultTemporaryDirectory(prefix) {
  const root = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

function runRecord(args, runtime = {}) {
  const values = options(args, {
    config: true,
    input: true,
    "output-dir": true,
    "platform-id": true,
    "platform-label": true,
    "shard-id": true,
    os: true,
    arch: true,
    runner: true,
    repository: true,
    sha: true,
    ref: true,
    "source-url": true,
    "run-url": true,
    timestamp: true,
    "github-output": true,
  });
  required(values, ["config", "input"], "record");
  const config = loadConfig(values.config);
  const parsed = parseGoBenchmark(
    fs.readFileSync(values.input, "utf8"),
    config,
  );
  const targetOS = values.os || parsed.fileConfig.goos || goOS();
  const targetArch = values.arch || parsed.fileConfig.goarch || goArch();
  const platformId = values["platform-id"] || `${targetOS}-${targetArch}`;
  const shardId = values["shard-id"] || process.env.GITHUB_JOB || "default";
  assert(
    safePart(platformId),
    `invalid platform id ${JSON.stringify(platformId)}`,
  );
  assert(safePart(shardId), `invalid shard id ${JSON.stringify(shardId)}`);
  const defaults = sourceDefaults();
  const repository = values.repository || defaults.repository;
  const sha = values.sha || defaults.sha;
  const sourceURL = values["source-url"] || defaultSourceURL(repository, sha);
  const result = {
    schemaVersion,
    suiteId: config.id,
    shardId,
    source: {
      repository,
      sha,
      ...(values.ref || defaults.ref
        ? { ref: values.ref || defaults.ref }
        : {}),
      url: sourceURL,
      ...(values["run-url"] || defaultRunURL()
        ? { runUrl: values["run-url"] || defaultRunURL() }
        : {}),
      timestamp: values.timestamp || new Date().toISOString(),
    },
    platform: {
      id: platformId,
      label:
        values["platform-label"] || `${displayOS(targetOS)} / ${targetArch}`,
      os: targetOS,
      arch: targetArch,
      ...(values.runner ? { runner: values.runner } : {}),
    },
    units: parsed.units,
    benchmarks: parsed.benchmarks,
  };
  const outputDirectory =
    values["output-dir"] ||
    defaultTemporaryDirectory(
      `go-benchmark-${config.id}-${platformId}-${shardId}-`,
    );
  writeArtifact(outputDirectory, config, result);
  const artifactName = `go-benchmark-${config.id}-${platformId}-${shardId}`;
  const outputs = {
    "artifact-name": artifactName,
    "artifact-path": outputDirectory,
    "platform-id": platformId,
    "shard-id": shardId,
    "suite-id": config.id,
  };
  writeOutputs(
    runtime.githubOutput ??
      values["github-output"] ??
      process.env.GITHUB_OUTPUT,
    outputs,
  );
  console.log(
    `Recorded ${parsed.benchmarks.length} benchmarks for ${platformId}/${shardId} in ${outputDirectory}`,
  );
  return { outputDirectory, outputs };
}

function series(values, prefix = "") {
  return {
    kind: values[`${prefix}series-kind`],
    id: values[`${prefix}series-id`],
    label: values[`${prefix}series-label`],
  };
}

function runRender(args, runtime = {}) {
  const values = options(args, {
    artifacts: true,
    "data-dir": true,
    "series-kind": true,
    "series-id": true,
    "series-label": true,
    "additional-series-kind": true,
    "additional-series-id": true,
    "additional-series-label": true,
    "site-base-url": true,
    comment: true,
    "github-output": true,
  });
  required(
    values,
    ["artifacts", "data-dir", "series-kind", "series-id", "series-label"],
    "render",
  );
  const loaded = loadArtifacts(values.artifacts);
  const primary = series(values);
  const updated = update(
    values["data-dir"],
    loaded.config,
    primary,
    loaded.results,
  );
  const additionalValues = [
    values["additional-series-kind"],
    values["additional-series-id"],
    values["additional-series-label"],
  ];
  if (additionalValues.some(Boolean)) {
    assert(
      additionalValues.every(Boolean),
      "additional series kind, id, and label must be provided together",
    );
    update(
      values["data-dir"],
      loaded.config,
      series(values, "additional-"),
      loaded.results,
    );
  }
  const commentPath =
    values.comment || path.join(values["data-dir"], ".go-benchmark-comment.md");
  const siteURL = values["site-base-url"]
    ? `${values["site-base-url"].replace(/\/+$/u, "")}/${loaded.config.sitePath.replace(/^\/+|\/+$/gu, "")}/?series=${encodeURIComponent(`${primary.kind}/${primary.id}`)}`
    : "";
  writeReport(commentPath, siteURL, loaded.config, updated.entry, updated.main);
  const outputs = {
    "comment-path": commentPath,
    marker: `<!-- go-benchmark:${loaded.config.id} -->`,
    "site-path": updated.sitePath,
    "site-url": siteURL,
    "suite-id": loaded.config.id,
  };
  writeOutputs(
    runtime.githubOutput ??
      values["github-output"] ??
      process.env.GITHUB_OUTPUT,
    outputs,
  );
  console.log(
    `Updated ${primary.kind} series ${primary.id} with ${loaded.results.length} platforms`,
  );
  return { outputs };
}

module.exports = { runRecord, runRender };
