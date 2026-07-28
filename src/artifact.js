"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { benchmarkKey } = require("./gobench");
const { loadSnapshot } = require("./config");
const {
  assert,
  compareText,
  hasControl,
  median,
  safePart,
  walkFiles,
  writeJSON,
} = require("./util");

const schemaVersion = 1;

function validLabel(value, field, max = 160) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max &&
      value.trim() === value &&
      !hasControl(value),
    `${field} must be a trimmed string of 1..${max} bytes`,
  );
}

function validURL(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid ${field} ${JSON.stringify(value)}`);
  }
  assert(
    parsed.protocol === "https:" &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      !/[<>\r\n]/u.test(value),
    `invalid ${field} ${JSON.stringify(value)}`,
  );
}

function validUnit(unit) {
  return (
    typeof unit === "string" &&
    Buffer.byteLength(unit) >= 1 &&
    Buffer.byteLength(unit) <= 64 &&
    !hasControl(unit) &&
    !/[\s`|<>]/u.test(unit)
  );
}

function validBenchmarkName(name) {
  return (
    typeof name === "string" &&
    name.startsWith("Benchmark") &&
    name.length > "Benchmark".length &&
    Buffer.byteLength(name) <= 300 &&
    !hasControl(name) &&
    !/[\s`|<>]/u.test(name)
  );
}

function validateMeasurements(key, measurements) {
  assert(
    measurements &&
      typeof measurements === "object" &&
      !Array.isArray(measurements) &&
      Object.keys(measurements).length >= 1 &&
      Object.keys(measurements).length <= 32,
    `benchmark ${JSON.stringify(key)} has an invalid measurement count`,
  );
  for (const [unit, value] of Object.entries(measurements)) {
    assert(
      validUnit(unit),
      `benchmark ${JSON.stringify(key)} has invalid unit ${JSON.stringify(unit)}`,
    );
    assert(
      typeof value === "number" && Number.isFinite(value) && value >= 0,
      `benchmark ${JSON.stringify(key)} unit ${JSON.stringify(unit)} has invalid value`,
    );
  }
}

function validateResult(result, config, options = {}) {
  const trustedLayout = options.trustedLayout ?? true;
  const maxBenchmarks = trustedLayout ? config.maxBenchmarks : 5000;
  assert(
    result?.schemaVersion === schemaVersion,
    `unsupported result schema ${result?.schemaVersion}`,
  );
  assert(
    result.suiteId === config.id,
    `suite id ${JSON.stringify(result.suiteId)} does not match config ${JSON.stringify(config.id)}`,
  );
  assert(
    safePart(result.shardId),
    `invalid shard id ${JSON.stringify(result.shardId)}`,
  );
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result.source?.repository),
    `invalid source repository ${JSON.stringify(result.source?.repository)}`,
  );
  assert(
    /^[0-9a-f]{40}$/u.test(result.source.sha),
    `invalid source SHA ${JSON.stringify(result.source.sha)}`,
  );
  validURL(result.source.url, "source URL");
  if (result.source.runUrl) validURL(result.source.runUrl, "run URL");
  assert(
    typeof result.source.timestamp === "string" &&
      !Number.isNaN(Date.parse(result.source.timestamp)),
    "source timestamp is invalid",
  );
  assert(
    safePart(result.platform?.id),
    `invalid platform id ${JSON.stringify(result.platform?.id)}`,
  );
  validLabel(result.platform.label, "platform label");
  assert(
    Array.isArray(result.benchmarks) &&
      result.benchmarks.length >= 1 &&
      result.benchmarks.length <= maxBenchmarks,
    `benchmark count is outside 1..${maxBenchmarks}`,
  );
  assert(
    Object.keys(result.units ?? {}).length <= 64,
    "unit metadata count exceeds 64",
  );
  for (const [unit, metadata] of Object.entries(result.units ?? {})) {
    assert(validUnit(unit), `invalid metadata unit ${JSON.stringify(unit)}`);
    assert(
      metadata.better === undefined ||
        metadata.better === "higher" ||
        metadata.better === "lower",
      `unit ${unit} has invalid better value`,
    );
    assert(
      metadata.assume === undefined ||
        metadata.assume === "nothing" ||
        metadata.assume === "exact",
      `unit ${unit} has invalid assume value`,
    );
  }
  const seen = new Set();
  for (const benchmark of result.benchmarks) {
    assert(
      validBenchmarkName(benchmark.name),
      `invalid benchmark name ${JSON.stringify(benchmark.name)}`,
    );
    assert(
      !benchmark.package || /^[A-Za-z0-9._~+/-]+$/u.test(benchmark.package),
      `benchmark ${benchmark.name} has invalid package ${JSON.stringify(benchmark.package)}`,
    );
    const key = benchmarkKey(benchmark);
    assert(!seen.has(key), `duplicate benchmark ${JSON.stringify(key)}`);
    seen.add(key);
    if (trustedLayout) {
      assert(
        config.includeBenchmark(benchmark.name, key),
        `benchmark ${JSON.stringify(key)} is excluded by trusted config`,
      );
      const layout = config.layoutFor(benchmark.name, key);
      assert(
        benchmark.group === layout.group && benchmark.chart === layout.chart,
        `benchmark ${JSON.stringify(key)} layout does not match trusted config`,
      );
    } else {
      assert(
        benchmark.group === "other" ||
          (safePart(benchmark.group) &&
            benchmark.group === benchmark.group.toLowerCase()),
        `benchmark ${JSON.stringify(key)} has invalid stored group`,
      );
      assert(
        benchmark.chart === `group:${benchmark.group}` ||
          benchmark.chart === `benchmark:${key}`,
        `benchmark ${JSON.stringify(key)} has invalid stored chart`,
      );
    }
    assert(
      Array.isArray(benchmark.samples) &&
        benchmark.samples.length >= 1 &&
        benchmark.samples.length <= 100,
      `benchmark ${JSON.stringify(key)} sample count is outside 1..100`,
    );
    const samples = new Map();
    for (const sample of benchmark.samples) {
      assert(
        Number.isSafeInteger(sample.iterations) && sample.iterations > 0,
        `benchmark ${JSON.stringify(key)} has invalid iterations`,
      );
      validateMeasurements(key, sample.measurements);
      for (const [unit, value] of Object.entries(sample.measurements)) {
        if (!samples.has(unit)) samples.set(unit, []);
        samples.get(unit).push(value);
      }
    }
    validateMeasurements(key, benchmark.measurements);
    assert(
      samples.size === Object.keys(benchmark.measurements).length,
      `benchmark ${JSON.stringify(key)} sample and summary units do not match`,
    );
    for (const [unit, value] of Object.entries(benchmark.measurements)) {
      assert(
        samples.has(unit) && value === median(samples.get(unit)),
        `benchmark ${JSON.stringify(key)} unit ${JSON.stringify(unit)} summary is not the sample median`,
      );
    }
  }
  return result;
}

function writeArtifact(directory, config, result) {
  validateResult(result, config);
  fs.mkdirSync(directory, { recursive: true });
  writeJSON(path.join(directory, "config.json"), config.toJSON());
  writeJSON(path.join(directory, "result.json"), result);
}

function canonicalConfig(config) {
  return JSON.stringify(config.toJSON());
}

function loadArtifacts(root) {
  const configPaths = walkFiles(root, "config.json");
  assert(
    configPaths.length !== 0,
    `no config.json artifacts found under ${root}`,
  );
  let config;
  let canonical;
  for (const filename of configPaths) {
    const current = loadSnapshot(filename);
    const encoded = canonicalConfig(current);
    if (!config) {
      config = current;
      canonical = encoded;
    } else {
      assert(
        canonical === encoded,
        `benchmark configurations do not match: ${filename}`,
      );
    }
  }
  const resultPaths = walkFiles(root, "result.json");
  assert(
    resultPaths.length !== 0,
    `no result.json artifacts found under ${root}`,
  );
  const results = resultPaths.map((filename) => {
    const result = JSON.parse(fs.readFileSync(filename, "utf8"));
    try {
      return validateResult(result, config);
    } catch (error) {
      throw new Error(`${filename}: ${error.message}`, { cause: error });
    }
  });
  return { config, results: mergeShards(results) };
}

function mergeMetadata(target, incoming, platform) {
  for (const [unit, metadata] of Object.entries(incoming ?? {})) {
    if (target[unit]) {
      assert(
        JSON.stringify(target[unit]) === JSON.stringify(metadata),
        `platform ${platform} has conflicting metadata for ${unit}`,
      );
    } else {
      target[unit] = metadata;
    }
  }
}

function mergeShards(shards) {
  assert(
    shards.length >= 1 && shards.length <= 256,
    "shard count is outside 1..256",
  );
  const first = shards[0];
  const sourceKey = `${first.source.repository}@${first.source.sha}`;
  const seenShards = new Set();
  const platforms = new Map();
  for (const shard of shards) {
    assert(
      `${shard.source.repository}@${shard.source.sha}` === sourceKey,
      `shard ${shard.shardId} source does not match ${sourceKey}`,
    );
    const shardKey = `${shard.platform.id}/${shard.shardId}`;
    assert(
      !seenShards.has(shardKey),
      `duplicate shard ${JSON.stringify(shardKey)}`,
    );
    seenShards.add(shardKey);
    let platform = platforms.get(shard.platform.id);
    if (!platform) {
      platform = {
        ...shard,
        shardId: "merged",
        units: {},
        benchmarks: [],
      };
      platforms.set(shard.platform.id, platform);
    } else {
      assert(
        JSON.stringify(platform.platform) === JSON.stringify(shard.platform),
        `platform ${shard.platform.id} metadata differs between shards`,
      );
    }
    mergeMetadata(platform.units, shard.units, shard.platform.id);
    const existing = new Set(platform.benchmarks.map(benchmarkKey));
    for (const benchmark of shard.benchmarks) {
      const key = benchmarkKey(benchmark);
      assert(
        !existing.has(key),
        `platform ${shard.platform.id} repeats benchmark ${JSON.stringify(key)} across shards`,
      );
      existing.add(key);
      platform.benchmarks.push(benchmark);
    }
    if (
      Date.parse(shard.source.timestamp) > Date.parse(platform.source.timestamp)
    ) {
      platform.source = shard.source;
    }
  }
  return [...platforms.values()]
    .map((result) => ({
      ...result,
      benchmarks: result.benchmarks.toSorted((left, right) =>
        compareText(benchmarkKey(left), benchmarkKey(right)),
      ),
    }))
    .sort((left, right) => compareText(left.platform.id, right.platform.id));
}

module.exports = {
  loadArtifacts,
  mergeShards,
  schemaVersion,
  validateResult,
  writeArtifact,
};
