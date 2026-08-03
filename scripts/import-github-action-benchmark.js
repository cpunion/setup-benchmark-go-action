"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { parseArgs } = require("node:util");
const { validateResult } = require("../src/artifact");
const { loadConfig } = require("../src/config");
const { migrateLegacyData } = require("../src/store");
const {
  assert,
  compareText,
  readJSONIfExists,
  writeJSON,
} = require("../src/util");

function readLegacy(filename) {
  const text = fs.readFileSync(filename, "utf8");
  const prefix = "window.BENCHMARK_DATA =";
  assert(
    text.trimStart().startsWith(prefix),
    `${filename} is not benchmark data`,
  );
  return JSON.parse(text.trimStart().slice(prefix.length));
}

function layout(config, name, packageName = "") {
  const key = packageName ? `${packageName}::${name}` : name;
  if (config.includeBenchmark(name, key)) return config.layoutFor(name, key);
  return { group: "other", chart: `benchmark:${key}` };
}

function platformFor(title) {
  if (title.startsWith("Linux ")) {
    return { id: "linux", label: "Linux", os: "linux", arch: "amd64" };
  }
  if (title.startsWith("macOS ")) {
    return { id: "macos", label: "macOS", os: "darwin", arch: "arm64" };
  }
  throw new Error(`unsupported legacy platform in ${JSON.stringify(title)}`);
}

function sourceFor(data, entry) {
  const repository = new URL(data.repoUrl).pathname.replace(/^\/+|\/+$/gu, "");
  return {
    repository,
    sha: entry.commit.id,
    url: entry.commit.url,
    timestamp: new Date(entry.date).toISOString(),
  };
}

function ensureResult(commits, config, data, title, legacy) {
  const platform = platformFor(title);
  const source = sourceFor(data, legacy);
  let commit = commits.get(source.sha);
  if (!commit) {
    commit = { platforms: new Map(), source };
    commits.set(source.sha, commit);
  } else if (
    Date.parse(source.timestamp) > Date.parse(commit.source.timestamp)
  ) {
    commit.source = source;
  }
  let result = commit.platforms.get(platform.id);
  if (!result) {
    result = {
      schemaVersion: 1,
      suiteId: config.id,
      shardId: "merged",
      source,
      platform,
      units: {},
      benchmarks: new Map(),
    };
    commit.platforms.set(platform.id, result);
  } else if (
    Date.parse(source.timestamp) > Date.parse(result.source.timestamp)
  ) {
    result.source = source;
  }
  return result;
}

function programBenchmark(result, config, workload) {
  const name = `BenchmarkProgram/${workload}`;
  let benchmark = result.benchmarks.get(name);
  if (!benchmark) {
    benchmark = {
      name,
      package: "github.com/goplus/llgo/benchmark/baseline",
      ...layout(config, name, "github.com/goplus/llgo/benchmark/baseline"),
      samples: [{ iterations: 1, measurements: {} }],
      measurements: {},
    };
    result.benchmarks.set(name, benchmark);
  }
  return benchmark;
}

const programMetrics = {
  file: "file-bytes",
  text: "text-bytes",
  data: "data-bytes",
  bss: "bss-bytes",
  compile: "build-ns",
  run: "run-ns",
};

function addProgram(result, config, item) {
  const parts = item.name.split("/");
  let workload;
  let metric;
  if (parts[0] === "binary" && parts.length === 3) {
    [, workload] = parts;
    metric = programMetrics[parts[2]];
  } else if (
    (parts[0] === "compile" || parts[0] === "run") &&
    parts.length === 2
  ) {
    workload = parts[1];
    metric = programMetrics[parts[0]];
  }
  assert(
    workload && metric,
    `unsupported legacy program benchmark ${item.name}`,
  );
  const benchmark = programBenchmark(result, config, workload);
  benchmark.samples[0].measurements[metric] = item.value;
  benchmark.measurements[metric] = item.value;
  result.units[metric] = {
    better: "lower",
    ...(metric.endsWith("-bytes") ? { assume: "exact" } : {}),
  };
}

function addGo(result, config, item) {
  const match = /^(Benchmark\S+) \(([^)]+)\)$/u.exec(item.name);
  assert(match, `unsupported legacy Go benchmark ${item.name}`);
  const [, name, packageName] = match;
  const iterations = Number.parseInt(item.extra ?? "", 10);
  assert(
    Number.isSafeInteger(iterations) && iterations > 0,
    `missing iterations for ${item.name}`,
  );
  const benchmark = {
    name,
    package: packageName,
    ...layout(config, name, packageName),
    samples: [{ iterations, measurements: { [item.unit]: item.value } }],
    measurements: { [item.unit]: item.value },
  };
  result.units[item.unit] = { better: "lower" };
  assert(
    !result.benchmarks.has(`${packageName}::${name}`),
    `duplicate legacy benchmark ${item.name}`,
  );
  result.benchmarks.set(`${packageName}::${name}`, benchmark);
}

function convert(data, config) {
  const commits = new Map();
  for (const [title, entries] of Object.entries(data.entries ?? {})) {
    for (const legacy of entries) {
      const result = ensureResult(commits, config, data, title, legacy);
      for (const item of legacy.benches ?? []) {
        if (legacy.tool === "go") addGo(result, config, item);
        else addProgram(result, config, item);
      }
    }
  }
  return [...commits.values()]
    .map((commit) => {
      const platforms = {};
      for (const result of commit.platforms.values()) {
        result.benchmarks = [...result.benchmarks.values()].sort(
          (left, right) =>
            compareText(
              `${left.package ?? ""}::${left.name}`,
              `${right.package ?? ""}::${right.name}`,
            ),
        );
        validateResult(result, config, { trustedLayout: false });
        platforms[result.platform.id] = result;
      }
      return { source: commit.source, platforms };
    })
    .sort(
      (left, right) =>
        Date.parse(left.source.timestamp) -
          Date.parse(right.source.timestamp) ||
        compareText(left.source.sha, right.source.sha),
    );
}

function run(args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "data-dir": { type: "string" },
      input: { type: "string" },
      "series-id": { type: "string" },
      "series-kind": { type: "string" },
      "series-label": { type: "string" },
    },
    strict: true,
  });
  for (const name of [
    "config",
    "data-dir",
    "input",
    "series-id",
    "series-kind",
    "series-label",
  ]) {
    assert(values[name], `import requires --${name}`);
  }
  const dataRoot = path.resolve(values["data-dir"]);
  const config = loadConfig(path.resolve(values.config));
  const entries = convert(readLegacy(path.resolve(values.input)), config);
  assert(entries.length > 0, "legacy benchmark data has no entries");
  const directory = path.join(
    dataRoot,
    ...config.sitePath.split("/"),
    "series",
    values["series-kind"],
    values["series-id"],
  );
  const historyPath = path.join(directory, "history.json");
  const history = readJSONIfExists(historyPath, {
    schemaVersion: 1,
    suiteId: config.id,
    kind: values["series-kind"],
    id: values["series-id"],
    label: values["series-label"],
    entries: [],
  });
  const bySource = new Map(
    [...history.entries, ...entries].map((entry) => [
      `${entry.source.repository}@${entry.source.sha}`,
      entry,
    ]),
  );
  history.entries = [...bySource.values()].sort(
    (left, right) =>
      Date.parse(left.source.timestamp) - Date.parse(right.source.timestamp) ||
      compareText(left.source.sha, right.source.sha),
  );
  writeJSON(historyPath, history);
  writeJSON(path.join(directory, "config.json"), config.toJSON());
  const migrated = migrateLegacyData(dataRoot, config.sitePath);
  return { entries: entries.length, ...migrated };
}

if (require.main === module) {
  const imported = run(process.argv.slice(2));
  console.log(
    `Imported ${imported.entries} legacy commits; migrated ${imported.series} series and ${imported.commits} commit files`,
  );
}

module.exports = { convert, run };
