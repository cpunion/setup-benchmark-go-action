"use strict";

const fs = require("node:fs");
const { benchmarkKey } = require("./gobench");
const { delta, formatNumber, markdown, tableCell } = require("./presentation");
const { compareText } = require("./util");
const { renderViews } = require("./view-report");

function baselineValue(entry, platformId, key, unit) {
  const benchmark = entry?.platforms?.[platformId]?.benchmarks?.find(
    (candidate) => benchmarkKey(candidate) === key,
  );
  return benchmark?.measurements?.[unit];
}

function groupTitle(config, id) {
  if (id === "other") return "Other";
  return config.groups[id]?.title ?? id;
}

function writeReport(
  filename,
  siteUrl,
  config,
  current,
  baseline,
  options = {},
) {
  const source = current.source;
  const sameRunner = options.sameRunner ?? false;
  const comparisonLabel = sameRunner ? "vs base" : "vs main";
  const lines = [
    `<!-- go-benchmark:${config.id} -->`,
    `## ${markdown(config.title)}`,
    "",
    `[\`${source.sha.slice(0, 12)}\`](<${source.url}>)` +
      (source.runUrl ? ` | [workflow run](<${source.runUrl}>)` : "") +
      (siteUrl ? ` | [long-term charts](<${siteUrl}>)` : ""),
    "",
  ];
  if (Object.keys(config.views).length > 0) {
    lines.push(...renderViews(config, current, baseline, comparisonLabel));
  } else {
    for (const platformId of Object.keys(current.platforms).sort(compareText)) {
      const result = current.platforms[platformId];
      lines.push(
        `### ${markdown(result.platform.label)}`,
        "",
        `| Group | Benchmark | Metric | Current | ${comparisonLabel} |`,
        "|---|---|---|---:|---:|",
      );
      for (const benchmark of result.benchmarks) {
        for (const unit of Object.keys(benchmark.measurements).sort(
          compareText,
        )) {
          const key = benchmarkKey(benchmark);
          lines.push(
            `| ${tableCell(groupTitle(config, benchmark.group))} | \`${key}\` | \`${unit}\` | ${formatNumber(benchmark.measurements[unit])} | ${delta(
              benchmark.measurements[unit],
              baselineValue(baseline, platformId, key, unit),
              result.units?.[unit]?.better,
            )} |`,
          );
        }
      }
      lines.push("");
    }
  }
  let comparisonNote;
  if (baseline && sameRunner) {
    comparisonNote = `_Compared with [\`${baseline.source.sha.slice(0, 12)}\`](<${baseline.source.url}>) measured in the same runner job._`;
  } else if (baseline) {
    comparisonNote =
      "_Compared only with the latest matching platform in the main series._";
  } else {
    comparisonNote =
      "_No main baseline exists yet; all metrics are marked `new`._";
  }
  lines.push(comparisonNote, "");
  if (Buffer.byteLength(lines.join("\n")) > 65_000) {
    throw new Error("benchmark report exceeds the GitHub comment size limit");
  }
  fs.mkdirSync(require("node:path").dirname(filename), { recursive: true });
  fs.writeFileSync(filename, lines.join("\n"));
}

module.exports = { delta, writeReport };
