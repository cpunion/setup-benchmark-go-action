"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateResult } = require("./artifact");
const { loadSnapshot } = require("./config");
const { benchmarkKey } = require("./gobench");
const {
  assert,
  compareText,
  hasControl,
  readJSONIfExists,
  safePart,
  walkFiles,
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

function validateEntry(entry, config) {
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
  return entry;
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
    validateEntry(entry, config);
  }
  history.label = series.label;
}

function emptyHistory(config, series) {
  return {
    schemaVersion,
    suiteId: config.id,
    kind: series.kind,
    id: series.id,
    label: series.label,
    entries: [],
  };
}

function mergeHistories(paths, config, series, nullable = false) {
  const histories = paths
    .map((filename) => readJSONIfExists(filename, null))
    .filter(Boolean);
  if (histories.length === 0)
    return nullable ? null : emptyHistory(config, series);
  const merged = emptyHistory(config, series);
  for (const history of histories) {
    validateHistory(history, config, series);
    for (const entry of history.entries) {
      const previous = merged.entries.findIndex((item) =>
        sameSource(item, entry),
      );
      if (previous === -1) {
        merged.entries.push(entry);
      } else if (compareEntries(merged.entries[previous], entry) <= 0) {
        merged.entries[previous] = entry;
      }
    }
  }
  merged.entries.sort(compareEntries);
  if (merged.entries.length > maxHistoryEntries) {
    merged.entries.splice(0, merged.entries.length - maxHistoryEntries);
  }
  return merged;
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

function sameSource(left, right) {
  return (
    left.source.repository === right.source.repository &&
    left.source.sha === right.source.sha
  );
}

function commitRelative(entry) {
  assert(
    /^[0-9a-f]{40}$/u.test(entry.source.sha),
    `invalid source SHA ${JSON.stringify(entry.source.sha)}`,
  );
  return path.posix.join("commits", `${entry.source.sha}.json`);
}

function writeCommit(siteRoot, config, entry, comparison = null) {
  validateEntry(entry, config);
  if (comparison) validateEntry(comparison, config);
  const relative = commitRelative(entry);
  const filename = path.join(siteRoot, ...relative.split("/"));
  const previous = readJSONIfExists(filename, null);
  let snapshot = entry;
  if (previous) {
    assert(
      previous.schemaVersion === schemaVersion &&
        previous.suiteId === config.id,
      `commit snapshot identity does not match ${config.id}`,
    );
    validateEntry(previous, config);
    assert(
      previous.source.sha === entry.source.sha,
      `commit snapshot source does not match ${entry.source.sha}`,
    );
    if (compareEntries(previous, entry) > 0) snapshot = previous;
    if (previous.comparison) {
      validateEntry(previous.comparison, config);
      comparison ??= previous.comparison;
    }
  }
  writeJSON(filename, {
    schemaVersion,
    suiteId: config.id,
    source: snapshot.source,
    platforms: snapshot.platforms,
    ...(comparison ? { comparison } : {}),
  });
  return relative;
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

function migrateLegacyData(dataRoot, sitePath) {
  const normalized = path.posix.normalize(sitePath);
  assert(
    normalized !== "." &&
      !normalized.startsWith("../") &&
      !path.posix.isAbsolute(normalized),
    `site path ${JSON.stringify(sitePath)} must stay within the data branch`,
  );
  const siteRoot = path.join(dataRoot, ...normalized.split("/"));
  const seriesRoot = path.join(siteRoot, "series");
  const legacyPaths = walkFiles(seriesRoot, "history.json");
  const indexPath = path.join(siteRoot, "series.json");
  const index = readJSONIfExists(indexPath, {
    schemaVersion,
    series: [],
  });
  assert(
    index.schemaVersion === schemaVersion && Array.isArray(index.series),
    "unsupported or invalid series index",
  );
  const commits = new Set();
  for (const legacyPath of legacyPaths) {
    const directory = path.dirname(legacyPath);
    const config = loadSnapshot(path.join(directory, "config.json"));
    assert(
      config.sitePath === normalized,
      `series config site path ${JSON.stringify(config.sitePath)} does not match ${JSON.stringify(normalized)}`,
    );
    const legacy = readJSONIfExists(legacyPath, null);
    const series = {
      kind: legacy?.kind,
      id: legacy?.id,
      label: legacy?.label,
    };
    validateSeries(series);
    validateHistory(legacy, config, series);
    const summaryPath = path.join(directory, "summary.json");
    const hadSummary = fs.existsSync(summaryPath);
    const history = mergeHistories([summaryPath, legacyPath], config, series);
    for (const entry of history.entries) {
      commits.add(commitRelative(entry));
      writeCommit(siteRoot, config, entry);
    }
    if (series.kind === "pull" && history.entries.length > 0) {
      const latest = history.entries[history.entries.length - 1];
      if (hadSummary) {
        const existing = readJSONIfExists(summaryPath, null);
        validateHistory(existing, config, series);
        const current = existing.entries[existing.entries.length - 1];
        if (!current || compareEntries(current, latest) < 0) {
          history.entries = [latest];
        } else {
          history.entries = existing.entries;
        }
      } else {
        history.entries = [latest];
      }
    }
    writeJSON(summaryPath, history);
    const latest = history.entries[history.entries.length - 1];
    let item = index.series.find(
      (candidate) =>
        candidate.kind === series.kind && candidate.id === series.id,
    );
    if (!item && latest) {
      item = {
        kind: series.kind,
        id: series.id,
        label: series.label,
        configPath: path.posix.join(
          "series",
          series.kind,
          series.id,
          "config.json",
        ),
        updatedAt: latest.source.timestamp,
      };
      index.series.push(item);
    }
    if (latest) {
      item.path = path.posix.join(
        "series",
        series.kind,
        series.id,
        "summary.json",
      );
      item.configPath = path.posix.join(
        "series",
        series.kind,
        series.id,
        "config.json",
      );
      item.commitPath = commitRelative(latest);
      item.sha = latest.source.sha;
      item.sourceUrl = latest.source.url;
    }
  }
  index.series.sort(compareSeries);
  writeJSON(indexPath, index);
  writeWeb(dataRoot, siteRoot);
  return { commits: commits.size, series: legacyPaths.length, siteRoot };
}

function update(dataRoot, config, series, results, options = {}) {
  validateSeries(series);
  const entry = entryFromResults(results, config);
  const relative = path.posix.join(
    "series",
    series.kind,
    series.id,
    "summary.json",
  );
  const legacyRelative = path.posix.join(
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
  const summaryPath = path.join(siteRoot, ...relative.split("/"));
  const legacyPath = path.join(siteRoot, ...legacyRelative.split("/"));
  const configPath = path.join(siteRoot, ...configRelative.split("/"));
  const history = mergeHistories([summaryPath, legacyPath], config, series);
  const comparison = options.comparison ?? null;
  if (comparison) validateEntry(comparison, config);
  if (series.kind === "pull") {
    for (const item of history.entries) writeCommit(siteRoot, config, item);
    history.entries =
      comparison && !sameSource(comparison, entry)
        ? [comparison, entry]
        : [entry];
  } else {
    const previous = history.entries.findIndex((item) =>
      sameSource(item, entry),
    );
    if (previous === -1) history.entries.push(entry);
    else history.entries[previous] = entry;
    history.entries.sort(compareEntries);
    if (history.entries.length > maxHistoryEntries) {
      history.entries.splice(0, history.entries.length - maxHistoryEntries);
    }
  }
  if (series.kind === "pull") {
    writeCommit(siteRoot, config, entry, comparison);
  } else {
    for (const item of history.entries) {
      writeCommit(
        siteRoot,
        config,
        item,
        sameSource(item, entry) ? comparison : null,
      );
    }
  }
  const commitPath = commitRelative(entry);
  writeJSON(summaryPath, history);
  writeJSON(legacyPath, history);
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
    commitPath,
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
    "summary.json",
  );
  const legacyMainPath = path.join(
    siteRoot,
    "series",
    "main",
    "main",
    "history.json",
  );
  const mainHistory = mergeHistories(
    [mainPath, legacyMainPath],
    config,
    { kind: "main", id: "main", label: "Main" },
    true,
  );
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
    commitPath: path.join(siteRoot, ...commitPath.split("/")),
    historyPath: summaryPath,
    summaryPath,
    sitePath: siteRoot,
  };
}

module.exports = {
  entryFromResults,
  latestMatchingPlatforms,
  migrateLegacyData,
  update,
};
