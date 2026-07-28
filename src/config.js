"use strict";

const path = require("node:path");
const YAML = require("yaml");
const { RE2JS } = require("re2js");
const { assert, hasControl, safePart } = require("./util");
const fs = require("node:fs");

function stringList(value, field) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [value];
  assert(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${field} must be a string or string list`,
  );
  return value;
}

function label(value, field, max = 120) {
  assert(typeof value === "string", `${field} must be a string`);
  assert(
    value.length > 0 &&
      Buffer.byteLength(value) <= max &&
      value.trim() === value,
    `${field} must be a trimmed string of 1..${max} bytes`,
  );
  assert(!hasControl(value), `${field} contains a control character`);
  return value;
}

function title(id) {
  return id
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function compilePatterns(values, field) {
  return values.map((value) => {
    try {
      return RE2JS.compile(value);
    } catch (error) {
      throw new Error(
        `${field} pattern ${JSON.stringify(value)}: ${error.message}`,
        {
          cause: error,
        },
      );
    }
  });
}

function matches(patterns, name, key) {
  const shortName = name.replace(/^Benchmark/u, "");
  const shortKey = key.replace("::Benchmark", "::");
  return patterns.some((pattern) =>
    [name, shortName, key, shortKey].some((value) =>
      pattern.matcher(value).find(),
    ),
  );
}

class Config {
  constructor(raw, source = "configuration") {
    assert(
      raw && typeof raw === "object" && !Array.isArray(raw),
      `${source} must be a mapping`,
    );
    this.version = raw.version ?? 1;
    assert(this.version === 1, `unsupported version ${this.version}`);
    this.id = raw.id;
    assert(
      typeof this.id === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(this.id),
      "invalid id",
    );
    this.title = label(raw.title ?? `${this.id} benchmarks`, "title");
    this.sitePath = path.posix.normalize(
      raw["site-path"] ?? `go-benchmarks/${this.id}`,
    );
    assert(
      this.sitePath !== "." &&
        !this.sitePath.startsWith("../") &&
        !path.posix.isAbsolute(this.sitePath),
      `site-path ${JSON.stringify(this.sitePath)} must stay within the data branch`,
    );
    this.include = stringList(raw.include, "include");
    if (this.include.length === 0) this.include = ["^Benchmark"];
    this.exclude = stringList(raw.exclude, "exclude");
    this.maxBenchmarks = raw["max-benchmarks"] ?? 500;
    assert(
      Number.isInteger(this.maxBenchmarks) &&
        this.maxBenchmarks >= 1 &&
        this.maxBenchmarks <= 5000,
      "max-benchmarks must be between 1 and 5000",
    );
    this.groups = {};
    this.compiledGroups = {};
    const groups = raw.groups ?? {};
    assert(
      groups && typeof groups === "object" && !Array.isArray(groups),
      "groups must be a mapping",
    );
    for (const [id, value] of Object.entries(groups)) {
      assert(
        safePart(id) && id === id.toLowerCase(),
        `invalid group id ${JSON.stringify(id)}`,
      );
      const group =
        typeof value === "string" || Array.isArray(value)
          ? { match: value }
          : { ...value };
      assert(
        group && typeof group === "object",
        `group ${id} must be a pattern or mapping`,
      );
      const match = stringList(group.match, `group ${id} match`);
      assert(match.length !== 0, `group ${id} has no match pattern`);
      const chart = group.chart ?? "combined";
      assert(
        chart === "combined" || chart === "single",
        `group ${id} chart must be combined or single`,
      );
      this.groups[id] = {
        title: label(group.title ?? title(id), `group ${id} title`),
        match,
        chart,
      };
      this.compiledGroups[id] = compilePatterns(match, `group ${id}`);
    }
    this.compiledInclude = compilePatterns(this.include, "include");
    this.compiledExclude = compilePatterns(this.exclude, "exclude");
  }

  includeBenchmark(name, key) {
    return (
      matches(this.compiledInclude, name, key) &&
      !matches(this.compiledExclude, name, key)
    );
  }

  layoutFor(name, key) {
    const groups = Object.keys(this.groups)
      .filter((id) => matches(this.compiledGroups[id], name, key))
      .sort();
    assert(
      groups.length <= 1,
      `benchmark ${JSON.stringify(key)} matches multiple groups: ${groups.join(", ")}`,
    );
    if (groups.length === 0)
      return { group: "other", chart: `benchmark:${key}` };
    const group = groups[0];
    return {
      group,
      chart:
        this.groups[group].chart === "single"
          ? `benchmark:${key}`
          : `group:${group}`,
    };
  }

  toJSON() {
    return {
      version: this.version,
      id: this.id,
      title: this.title,
      sitePath: this.sitePath,
      include: this.include,
      exclude: this.exclude,
      maxBenchmarks: this.maxBenchmarks,
      groups: this.groups,
    };
  }
}

function loadConfig(filename) {
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(filename, "utf8"), { uniqueKeys: true });
  } catch (error) {
    throw new Error(`parse ${filename}: ${error.message}`, { cause: error });
  }
  return new Config(raw, filename);
}

function loadSnapshot(filename) {
  const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
  const translated = {
    ...raw,
    "site-path": raw.sitePath,
    "max-benchmarks": raw.maxBenchmarks,
  };
  return new Config(translated, filename);
}

module.exports = { Config, loadConfig, loadSnapshot };
