"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const {
  loadArtifacts,
  validateResult,
  writeArtifact,
  schemaVersion,
} = require("./artifact");
const { loadConfig } = require("./config");
const { parseGoBenchmark } = require("./gobench");
const { writeReport } = require("./report");
const { entryFromResults, update } = require("./store");
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

function baselineSourceDefaults() {
  const base = githubEvent().pull_request?.base;
  return {
    repository: base?.repo?.full_name || "",
    sha: base?.sha || "",
    ref: base?.ref || "",
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
    "baseline-input": true,
    "baseline-repository": true,
    "baseline-sha": true,
    "baseline-ref": true,
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
  const runURL = values["run-url"] || defaultRunURL();
  const timestamp = values.timestamp || new Date().toISOString();
  const platform = {
    id: platformId,
    label: values["platform-label"] || `${displayOS(targetOS)} / ${targetArch}`,
    os: targetOS,
    arch: targetArch,
    ...(values.runner ? { runner: values.runner } : {}),
  };
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
      ...(runURL ? { runUrl: runURL } : {}),
      timestamp,
    },
    platform,
    units: parsed.units,
    benchmarks: parsed.benchmarks,
  };
  let baseline = null;
  if (values["baseline-input"]) {
    const baselineDefaults = baselineSourceDefaults();
    const baselineRepository =
      values["baseline-repository"] || baselineDefaults.repository;
    const baselineSHA = values["baseline-sha"] || baselineDefaults.sha;
    const baselineRef = values["baseline-ref"] || baselineDefaults.ref;
    assert(
      baselineRepository && baselineSHA,
      "baseline repository and SHA are required with --baseline-input",
    );
    const baselineParsed = parseGoBenchmark(
      fs.readFileSync(values["baseline-input"], "utf8"),
      config,
    );
    baseline = {
      schemaVersion,
      suiteId: config.id,
      shardId,
      source: {
        repository: baselineRepository,
        sha: baselineSHA,
        ...(baselineRef ? { ref: baselineRef } : {}),
        url: defaultSourceURL(baselineRepository, baselineSHA),
        ...(runURL ? { runUrl: runURL } : {}),
        timestamp,
      },
      platform,
      units: baselineParsed.units,
      benchmarks: baselineParsed.benchmarks,
    };
  }
  const outputDirectory =
    values["output-dir"] ||
    defaultTemporaryDirectory(
      `go-benchmark-${config.id}-${platformId}-${shardId}-`,
    );
  writeArtifact(outputDirectory, config, result, baseline);
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

function bindSource(results, config, values) {
  const expectedRepository = values["expected-source-repository"];
  const expectedSHA = values["expected-source-sha"];
  assert(
    Boolean(expectedRepository) === Boolean(expectedSHA),
    "expected source repository and SHA must be provided together",
  );
  for (const result of results) {
    if (expectedRepository) {
      assert(
        result.source.repository === expectedRepository,
        `artifact source repository ${JSON.stringify(result.source.repository)} does not match ${JSON.stringify(expectedRepository)}`,
      );
      assert(
        result.source.sha === expectedSHA,
        `artifact source SHA ${JSON.stringify(result.source.sha)} does not match ${JSON.stringify(expectedSHA)}`,
      );
    }
    result.source = {
      ...result.source,
      ...(values["source-ref"] ? { ref: values["source-ref"] } : {}),
      ...(values["source-url"] ? { url: values["source-url"] } : {}),
      ...(values["source-run-url"] ? { runUrl: values["source-run-url"] } : {}),
      ...(values["source-timestamp"]
        ? { timestamp: values["source-timestamp"] }
        : {}),
    };
    validateResult(result, config);
  }
}

function bindBaselineSource(results, config, values) {
  if (results.length === 0) return;
  const expectedRepository = values["expected-baseline-repository"];
  const expectedSHA = values["expected-baseline-sha"];
  assert(
    expectedRepository,
    "expected baseline repository is required with a paired baseline",
  );
  for (const result of results) {
    assert(
      result.source.repository === expectedRepository,
      `artifact baseline repository ${JSON.stringify(result.source.repository)} does not match ${JSON.stringify(expectedRepository)}`,
    );
    if (expectedSHA) {
      assert(
        result.source.sha === expectedSHA,
        `artifact baseline SHA ${JSON.stringify(result.source.sha)} does not match ${JSON.stringify(expectedSHA)}`,
      );
    }
    const baselineSHA = expectedSHA || result.source.sha;
    result.source = {
      ...result.source,
      repository: expectedRepository,
      sha: baselineSHA,
      ...(values["baseline-source-ref"]
        ? { ref: values["baseline-source-ref"] }
        : {}),
      url: defaultSourceURL(expectedRepository, baselineSHA),
      ...(values["source-run-url"] ? { runUrl: values["source-run-url"] } : {}),
      ...(values["source-timestamp"]
        ? { timestamp: values["source-timestamp"] }
        : {}),
    };
    validateResult(result, config);
  }
}

function bindConfig(loaded, filename) {
  if (!filename) return;
  const trusted = loadConfig(filename);
  assert(
    JSON.stringify(loaded.config.toJSON()) === JSON.stringify(trusted.toJSON()),
    "artifact configuration does not match the trusted configuration",
  );
  for (const result of loaded.results) validateResult(result, trusted);
  for (const baseline of loaded.baselines) validateResult(baseline, trusted);
  loaded.config = trusted;
}

function runRender(args, runtime = {}) {
  const values = options(args, {
    artifacts: true,
    "data-dir": true,
    "trusted-config": true,
    "series-kind": true,
    "series-id": true,
    "series-label": true,
    "additional-series-kind": true,
    "additional-series-id": true,
    "additional-series-label": true,
    "site-base-url": true,
    "expected-source-repository": true,
    "expected-source-sha": true,
    "expected-baseline-repository": true,
    "expected-baseline-sha": true,
    "baseline-source-ref": true,
    "source-ref": true,
    "source-url": true,
    "source-run-url": true,
    "source-timestamp": true,
    comment: true,
    "github-output": true,
  });
  required(
    values,
    ["artifacts", "data-dir", "series-kind", "series-id", "series-label"],
    "render",
  );
  const loaded = loadArtifacts(values.artifacts);
  bindConfig(loaded, values["trusted-config"]);
  bindSource(loaded.results, loaded.config, values);
  bindBaselineSource(loaded.baselines, loaded.config, values);
  const primary = series(values);
  const pairedBaseline =
    loaded.baselines.length === 0
      ? null
      : entryFromResults(loaded.baselines, loaded.config);
  const updated = update(
    values["data-dir"],
    loaded.config,
    primary,
    loaded.results,
    { comparison: primary.kind === "pull" ? pairedBaseline : null },
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
      { comparison: pairedBaseline },
    );
  }
  const commentPath =
    values.comment || path.join(values["data-dir"], ".go-benchmark-comment.md");
  const siteURL = values["site-base-url"]
    ? `${values["site-base-url"].replace(/\/+$/u, "")}/${loaded.config.sitePath.replace(/^\/+|\/+$/gu, "")}/?series=${encodeURIComponent(`${primary.kind}/${primary.id}`)}`
    : "";
  writeReport(
    commentPath,
    siteURL,
    loaded.config,
    updated.entry,
    pairedBaseline || updated.main,
    { sameRunner: Boolean(pairedBaseline) },
  );
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
