"use strict";

const fs = require("node:fs");
const { benchmarkKey } = require("./gobench");
const { compareText } = require("./util");

function markdown(value) {
  return value.replace(/[\\*_[\]#`]/gu, "\\$&");
}

function tableCell(value) {
  return markdown(value).replaceAll("|", "\\|");
}

function format(value) {
  if (Number.isInteger(value) && value < 1e12) return String(value);
  return value.toFixed(3);
}

function baselineValue(entry, platformId, key, unit) {
  const benchmark = entry?.platforms?.[platformId]?.benchmarks?.find(
    (candidate) => benchmarkKey(candidate) === key,
  );
  return benchmark?.measurements?.[unit];
}

function delta(current, baseline, better) {
  if (baseline === undefined) return "new";
  if (baseline === 0) return current === 0 ? "0.0%" : "from 0";
  const change = (current / baseline - 1) * 100;
  const value = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
  if (change === 0 || (better !== "lower" && better !== "higher")) return value;
  const improved =
    (better === "lower" && change < 0) || (better === "higher" && change > 0);
  return `${value} (${improved ? "better" : "worse"})`;
}

function groupTitle(config, id) {
  if (id === "other") return "Other";
  return config.groups[id]?.title ?? id;
}

function writeReport(filename, siteUrl, config, current, baseline) {
  const source = current.source;
  const lines = [
    `<!-- go-benchmark:${config.id} -->`,
    `## ${markdown(config.title)}`,
    "",
    `[\`${source.sha.slice(0, 12)}\`](<${source.url}>)` +
      (source.runUrl ? ` | [workflow run](<${source.runUrl}>)` : "") +
      (siteUrl ? ` | [long-term charts](<${siteUrl}>)` : ""),
    "",
  ];
  for (const platformId of Object.keys(current.platforms).sort(compareText)) {
    const result = current.platforms[platformId];
    lines.push(
      `### ${markdown(result.platform.label)}`,
      "",
      "| Group | Benchmark | Metric | Current | vs main |",
      "|---|---|---|---:|---:|",
    );
    for (const benchmark of result.benchmarks) {
      for (const unit of Object.keys(benchmark.measurements).sort(
        compareText,
      )) {
        const key = benchmarkKey(benchmark);
        lines.push(
          `| ${tableCell(groupTitle(config, benchmark.group))} | \`${key}\` | \`${unit}\` | ${format(benchmark.measurements[unit])} | ${delta(
            benchmark.measurements[unit],
            baselineValue(baseline, platformId, key, unit),
            result.units?.[unit]?.better,
          )} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push(
    baseline
      ? "_Compared only with the latest matching platform in the main series._"
      : "_No main baseline exists yet; all metrics are marked `new`._",
    "",
  );
  fs.mkdirSync(require("node:path").dirname(filename), { recursive: true });
  fs.writeFileSync(filename, lines.join("\n"));
}

module.exports = { delta, writeReport };
