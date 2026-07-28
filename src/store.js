"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateResult } = require("./artifact");
const { benchmarkKey } = require("./gobench");
const {
  assert,
  compareText,
  hasControl,
  readJSONIfExists,
  safePart,
  writeJSON,
} = require("./util");

const schemaVersion = 1;
const maxHistoryEntries = 500;
const webFiles = ["app.js", "index.html", "styles.css"];

function validateLabel(value, field) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 160 &&
      value.trim() === value &&
      !hasControl(value),
    `${field} must be a trimmed string of 1..160 bytes`,
  );
}

function validateSeries(series) {
  assert(
    series?.kind === "main" ||
      series?.kind === "branch" ||
      series?.kind === "pull",
    `unsupported series kind ${JSON.stringify(series?.kind)}`,
  );
  assert(safePart(series.id), `invalid series id ${JSON.stringify(series.id)}`);
  validateLabel(series.label, "series label");
}

function normalizeStoredResult(result, config) {
  if (!result.shardId) result.shardId = "merged";
  for (const benchmark of result.benchmarks ?? []) {
    if (!benchmark.chart) {
      benchmark.chart =
        benchmark.group === "other"
          ? `benchmark:${benchmarkKey(benchmark)}`
          : `group:${benchmark.group}`;
    }
  }
  return validateResult(result, config, { trustedLayout: false });
}

function validateHistory(history, config, series) {
  assert(
    history.schemaVersion === schemaVersion,
    `unsupported history schema ${history.schemaVersion}`,
  );
  assert(
    history.suiteId === config.id &&
      history.kind === series.kind &&
      history.id === series.id,
    `history identity does not match ${config.id}/${series.kind}/${series.id}`,
  );
  assert(
    Array.isArray(history.entries) &&
      history.entries.length <= maxHistoryEntries,
    "history entries are invalid",
  );
  for (const entry of history.entries) {
    assert(
      entry?.source && entry.platforms && typeof entry.platforms === "object",
      "history entry is invalid",
    );
    for (const [id, result] of Object.entries(entry.platforms)) {
      assert(
        result?.platform?.id === id,
        `history platform key ${JSON.stringify(id)} does not match its result`,
      );
      normalizeStoredResult(result, config);
      assert(
        result.source.repository === entry.source.repository &&
          result.source.sha === entry.source.sha,
        `history platform ${id} source does not match its entry`,
      );
    }
  }
  history.label = series.label;
}

function entryFromResults(results, config) {
  assert(results.length !== 0, "cannot update history without results");
  const source = results[0].source;
  const platforms = {};
  for (const result of results) {
    validateResult(result, config);
    assert(
      result.source.repository === source.repository &&
        result.source.sha === source.sha,
      `platform ${result.platform.id} does not match source ${source.repository}@${source.sha}`,
    );
    assert(
      !Object.hasOwn(platforms, result.platform.id),
      `duplicate platform ${JSON.stringify(result.platform.id)}`,
    );
    platforms[result.platform.id] = result;
  }
  return { source, platforms };
}

function compareEntries(left, right) {
  const time =
    Date.parse(left.source.timestamp) - Date.parse(right.source.timestamp);
  return time || compareText(left.source.sha, right.source.sha);
}

function compareSeries(left, right) {
  const rank = { main: 0, branch: 1, pull: 2 };
  return (
    rank[left.kind] - rank[right.kind] ||
    compareText(left.label, right.label) ||
    compareText(left.id, right.id)
  );
}

function latestMatchingPlatforms(history, current) {
  if (!history?.entries?.length) return null;
  const platforms = {};
  let source;
  for (
    let index = history.entries.length - 1;
    index >= 0 && Object.keys(platforms).length < Object.keys(current).length;
    index -= 1
  ) {
    const entry = history.entries[index];
    for (const id of Object.keys(current)) {
      if (!Object.hasOwn(platforms, id) && entry.platforms[id]) {
        platforms[id] = entry.platforms[id];
        source ??= entry.source;
      }
    }
  }
  return Object.keys(platforms).length === 0 ? null : { source, platforms };
}

function writeWeb(dataRoot, siteRoot) {
  const sourceRoot = [
    path.resolve(__dirname, "..", "web"),
    path.resolve(__dirname, "..", "..", "web"),
  ].find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
  assert(sourceRoot, "bundled web assets are missing");
  for (const name of webFiles) {
    const source = path.join(sourceRoot, name);
    const destination = path.join(siteRoot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.writeFileSync(path.join(dataRoot, ".nojekyll"), "");
}

function update(dataRoot, config, series, results) {
  validateSeries(series);
  const entry = entryFromResults(results, config);
  const relative = path.posix.join(
    "series",
    series.kind,
    series.id,
    "history.json",
  );
  const configRelative = path.posix.join(
    "series",
    series.kind,
    series.id,
    "config.json",
  );
  const siteRoot = path.join(dataRoot, ...config.sitePath.split("/"));
  const historyPath = path.join(siteRoot, ...relative.split("/"));
  const configPath = path.join(siteRoot, ...configRelative.split("/"));
  const history = readJSONIfExists(historyPath, {
    schemaVersion,
    suiteId: config.id,
    kind: series.kind,
    id: series.id,
    label: series.label,
    entries: [],
  });
  validateHistory(history, config, series);
  const previous = history.entries.findIndex(
    (item) => item.source.sha === entry.source.sha,
  );
  if (previous === -1) history.entries.push(entry);
  else history.entries[previous] = entry;
  history.entries.sort(compareEntries);
  if (history.entries.length > maxHistoryEntries) {
    history.entries.splice(0, history.entries.length - maxHistoryEntries);
  }
  writeJSON(historyPath, history);
  writeJSON(configPath, config.toJSON());

  const indexPath = path.join(siteRoot, "series.json");
  const index = readJSONIfExists(indexPath, {
    schemaVersion,
    series: [],
  });
  assert(
    index.schemaVersion === schemaVersion && Array.isArray(index.series),
    "unsupported or invalid series index",
  );
  const item = {
    kind: series.kind,
    id: series.id,
    label: series.label,
    path: relative,
    configPath: configRelative,
    sha: entry.source.sha,
    sourceUrl: entry.source.url,
    updatedAt: new Date().toISOString(),
  };
  const itemIndex = index.series.findIndex(
    (candidate) => candidate.kind === item.kind && candidate.id === item.id,
  );
  if (itemIndex === -1) index.series.push(item);
  else index.series[itemIndex] = item;
  index.series.sort(compareSeries);
  writeJSON(indexPath, index);
  writeWeb(dataRoot, siteRoot);

  const mainPath = path.join(
    siteRoot,
    "series",
    "main",
    "main",
    "history.json",
  );
  const mainHistory = readJSONIfExists(mainPath, null);
  if (mainHistory) {
    validateHistory(mainHistory, config, {
      kind: "main",
      id: "main",
      label: mainHistory.label || "Main",
    });
  }
  return {
    entry,
    main: latestMatchingPlatforms(mainHistory, entry.platforms),
    historyPath,
    sitePath: siteRoot,
  };
}

module.exports = { latestMatchingPlatforms, update };
