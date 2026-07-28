"use strict";

const { assert, compareText, median } = require("./util");

const defaultBetter = new Map([
  ["ns/op", "lower"],
  ["sec/op", "lower"],
  ["MB/s", "higher"],
  ["B/s", "higher"],
  ["B/op", "lower"],
  ["allocs/op", "lower"],
]);

function parseNumber(text, context) {
  const value = Number(text);
  assert(
    Number.isFinite(value) && value >= 0,
    `${context} has invalid value ${JSON.stringify(text)}`,
  );
  return value;
}

function parseIterations(text, key) {
  assert(
    /^[0-9]+$/u.test(text),
    `benchmark ${JSON.stringify(key)} has invalid iteration count ${JSON.stringify(text)}`,
  );
  const value = Number(text);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `benchmark ${JSON.stringify(key)} has invalid iteration count ${JSON.stringify(text)}`,
  );
  return value;
}

function parseUnitLine(fields, units, lineNumber) {
  assert(fields.length >= 2, `line ${lineNumber}: missing unit`);
  const unit = fields[1];
  for (const field of fields.slice(2)) {
    const index = field.indexOf("=");
    assert(index > 0, `line ${lineNumber}: expected key=value`);
    const key = field.slice(0, index);
    const value = field.slice(index + 1);
    assert(
      key === "better" || key === "assume",
      `line ${lineNumber}: unsupported unit metadata ${key}`,
    );
    if (key === "better")
      assert(
        value === "higher" || value === "lower",
        `line ${lineNumber}: invalid better value ${value}`,
      );
    if (key === "assume")
      assert(
        value === "nothing" || value === "exact",
        `line ${lineNumber}: invalid assume value ${value}`,
      );
    const metadata = units[unit] ?? {};
    assert(
      metadata[key] === undefined || metadata[key] === value,
      `line ${lineNumber}: conflicting ${key} metadata for ${unit}`,
    );
    metadata[key] = value;
    units[unit] = metadata;
  }
}

function parseBenchmarkLine(fields, pkg, config, byKey, lineNumber) {
  assert(
    fields.length >= 4 && (fields.length - 2) % 2 === 0,
    `line ${lineNumber}: malformed benchmark result`,
  );
  const name = fields[0].replace(/-[0-9]+$/u, "");
  const key = pkg ? `${pkg}::${name}` : name;
  if (!config.includeBenchmark(name, key)) return;
  const iterations = parseIterations(fields[1], key);
  const measurements = {};
  for (let index = 2; index < fields.length; index += 2) {
    const unit = fields[index + 1];
    assert(
      unit && !Object.hasOwn(measurements, unit),
      `benchmark ${JSON.stringify(key)} repeats unit ${JSON.stringify(unit)}`,
    );
    measurements[unit] = parseNumber(
      fields[index],
      `benchmark ${JSON.stringify(key)} unit ${JSON.stringify(unit)}`,
    );
  }
  let benchmark = byKey.get(key);
  if (!benchmark) {
    const layout = config.layoutFor(name, key);
    benchmark = {
      name,
      ...(pkg ? { package: pkg } : {}),
      group: layout.group,
      chart: layout.chart,
      samples: [],
      measurements: {},
    };
    byKey.set(key, benchmark);
  }
  benchmark.samples.push({ iterations, measurements });
}

function summarize(benchmark) {
  const byUnit = new Map();
  for (const sample of benchmark.samples) {
    for (const [unit, value] of Object.entries(sample.measurements)) {
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push(value);
    }
  }
  benchmark.measurements = Object.fromEntries(
    [...byUnit.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([unit, values]) => [unit, median(values)]),
  );
  return benchmark;
}

function parseGoBenchmark(text, config) {
  const byKey = new Map();
  const units = {};
  const fileConfig = {};
  let pkg = "";
  for (const [offset, rawLine] of text.split(/\r?\n/u).entries()) {
    const lineNumber = offset + 1;
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/u);
    if (fields[0] === "Unit") {
      parseUnitLine(fields, units, lineNumber);
      continue;
    }
    if (fields[0].startsWith("Benchmark")) {
      parseBenchmarkLine(fields, pkg, config, byKey, lineNumber);
      continue;
    }
    const configMatch = /^([a-z][a-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (configMatch) {
      const [, key, value] = configMatch;
      fileConfig[key] = value;
      if (key === "pkg") pkg = value;
    }
  }
  assert(byKey.size !== 0, "no included Go benchmarks found");
  assert(
    byKey.size <= config.maxBenchmarks,
    `benchmark count exceeds max-benchmarks ${config.maxBenchmarks}`,
  );
  const benchmarks = [...byKey.values()]
    .map(summarize)
    .sort((left, right) =>
      compareText(benchmarkKey(left), benchmarkKey(right)),
    );
  for (const benchmark of benchmarks) {
    for (const unit of Object.keys(benchmark.measurements)) {
      if (!units[unit] && defaultBetter.has(unit))
        units[unit] = { better: defaultBetter.get(unit) };
    }
  }
  return { benchmarks, units, fileConfig };
}

function benchmarkKey(benchmark) {
  return benchmark.package
    ? `${benchmark.package}::${benchmark.name}`
    : benchmark.name;
}

module.exports = { benchmarkKey, parseGoBenchmark };
