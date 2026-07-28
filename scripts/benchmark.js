"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateResult } = require("../src/artifact");
const { Config } = require("../src/config");
const { parseGoBenchmark } = require("../src/gobench");

const targetNanoseconds = 100_000_000n;
const sampleCount = 5;
let sink;

const config = new Config({
  id: "self",
  groups: {
    core: "^(Parse|Group|Validate)",
    bundle: "Bundle$",
  },
});

function benchmarkText() {
  const lines = [
    "goos: linux",
    "goarch: amd64",
    "pkg: github.com/cpunion/setup-benchmark-go-action",
  ];
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      `BenchmarkCase${index}-8 1000 ${10 + index / 10} ns/op ${64 + index} B/op`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const input = benchmarkText();
const permissive = new Config({ id: "self" });
const parsed = parseGoBenchmark(input, permissive);
const artifact = {
  schemaVersion: 1,
  suiteId: "self",
  shardId: "benchmark",
  source: {
    repository: "cpunion/setup-benchmark-go-action",
    sha: "1111111111111111111111111111111111111111",
    url: "https://github.com/cpunion/setup-benchmark-go-action/commit/1111111111111111111111111111111111111111",
    timestamp: "2026-07-28T00:00:00.000Z",
  },
  platform: { id: "linux-amd64", label: "Linux / amd64" },
  units: parsed.units,
  benchmarks: parsed.benchmarks,
};
const names = Array.from(
  { length: 100 },
  (_, index) =>
    `Benchmark${index % 3 === 0 ? "Parse" : index % 3 === 1 ? "Group" : "Validate"}Case${index}`,
);

function run(iterations, operation) {
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    sink = operation();
  }
  return process.hrtime.bigint() - start;
}

function calibratedIterations(operation) {
  for (let index = 0; index < 20; index += 1) sink = operation();
  let iterations = 1;
  let elapsed = run(iterations, operation);
  while (elapsed < targetNanoseconds / 10n && iterations < 1_000_000) {
    iterations *= 2;
    elapsed = run(iterations, operation);
  }
  const scaled = Number((BigInt(iterations) * targetNanoseconds) / elapsed);
  return Math.max(iterations, Math.min(10_000_000, scaled));
}

function measure(name, operation) {
  const iterations = calibratedIterations(operation);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const elapsed = run(iterations, operation);
    const nanoseconds = Number(elapsed) / iterations;
    console.log(`${name} ${iterations} ${nanoseconds.toFixed(3)} ns/op`);
  }
}

function bundleSize(name, filename) {
  console.log(`${name} 1 ${fs.statSync(filename).size} binary-bytes`);
}

const goos = { win32: "windows" }[process.platform] ?? process.platform;
const goarch = { x64: "amd64", ia32: "386" }[process.arch] ?? process.arch;
console.log(`goos: ${goos}`);
console.log(`goarch: ${goarch}`);
console.log("pkg: github.com/cpunion/setup-benchmark-go-action");
console.log("Unit ns/op better=lower");
console.log("Unit binary-bytes better=lower assume=exact");

measure("BenchmarkParseGoOutput40", () => parseGoBenchmark(input, permissive));
measure("BenchmarkGroupRules100", () => {
  for (const name of names) config.layoutFor(name, name);
  return names.length;
});
measure("BenchmarkValidateArtifact40", () =>
  validateResult(artifact, permissive),
);
bundleSize(
  "BenchmarkRecordBundle",
  path.resolve(__dirname, "..", "dist", "index.js"),
);
bundleSize(
  "BenchmarkRenderBundle",
  path.resolve(__dirname, "..", "publish", "dist", "index.js"),
);

if (sink === undefined) process.exitCode = 1;
