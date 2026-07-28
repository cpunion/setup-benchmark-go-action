"use strict";

const { benchmarkKey } = require("./gobench");
const { delta, formatNumber, markdown, tableCell } = require("./presentation");
const { assert, compareText } = require("./util");

const dimensionTitles = {
  platform: "Platform",
  package: "Package",
  group: "Group",
  benchmark: "Benchmark",
  metric: "Metric",
};

function groupTitle(config, id) {
  if (id === "other") return "Other";
  return config.groups[id]?.title ?? id;
}

function baselineValue(entry, platformId, key, unit) {
  const benchmark = entry?.platforms?.[platformId]?.benchmarks?.find(
    (candidate) => benchmarkKey(candidate) === key,
  );
  return benchmark?.measurements?.[unit];
}

function observations(config, current, baseline) {
  const values = [];
  for (const platformId of Object.keys(current.platforms).sort(compareText)) {
    const result = current.platforms[platformId];
    for (const benchmark of result.benchmarks) {
      const key = benchmarkKey(benchmark);
      for (const metric of Object.keys(benchmark.measurements).sort(
        compareText,
      )) {
        values.push({
          dimensions: {
            platform: { key: platformId, label: result.platform.label },
            package: {
              key: benchmark.package ?? "",
              label: benchmark.package || "(root)",
            },
            group: {
              key: benchmark.group,
              label: groupTitle(config, benchmark.group),
            },
            benchmark: { key, label: benchmark.name },
            metric: { key: metric, label: metric },
          },
          value: benchmark.measurements[metric],
          baseline: baselineValue(baseline, platformId, key, metric),
          better: result.units?.[metric]?.better,
        });
      }
    }
  }
  return values;
}

function tuple(observation, dimensions) {
  return dimensions.map((dimension) => observation.dimensions[dimension]);
}

function tupleKey(values) {
  return JSON.stringify(values.map((value) => value.key));
}

function trim(value, prefix) {
  return prefix && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value;
}

function tupleLabels(values, dimensions, view) {
  return values.map((value, index) => {
    const dimension = dimensions[index];
    if (dimension === "metric") {
      return view.metrics[value.key]?.title ?? value.label;
    }
    return trim(value.label, view.dimensionOptions[dimension]?.trimPrefix);
  });
}

function dimensionTitle(view, dimension) {
  return view.dimensionOptions[dimension]?.title ?? dimensionTitles[dimension];
}

function formatDuration(value, base) {
  const nanoseconds = value * { ns: 1, us: 1e3, ms: 1e6, s: 1e9 }[base];
  if (nanoseconds >= 1e9) return `${formatNumber(nanoseconds / 1e9)} s`;
  if (nanoseconds >= 1e6) return `${formatNumber(nanoseconds / 1e6)} ms`;
  if (nanoseconds >= 1e3) return `${formatNumber(nanoseconds / 1e3)} us`;
  return `${formatNumber(nanoseconds)} ns`;
}

function formatValue(value, metric, view) {
  const format = view.metrics[metric]?.format ?? "auto";
  if (format === "number") return formatNumber(value);
  if (format === "bytes") return `${formatNumber(value)} B`;
  if (format.startsWith("duration-")) {
    return formatDuration(value, format.slice("duration-".length));
  }
  return `${formatNumber(value)} ${metric}`;
}

function metricRank(view, value) {
  const configured = Object.keys(view.metrics).indexOf(value.key);
  return configured === -1 ? Number.MAX_SAFE_INTEGER : configured;
}

function compareTuple(left, right, dimensions, view) {
  for (let index = 0; index < dimensions.length; index += 1) {
    if (dimensions[index] === "metric") {
      const rank =
        metricRank(view, left[index]) - metricRank(view, right[index]);
      if (rank !== 0) return rank;
    }
    const compared = compareText(left[index].key, right[index].key);
    if (compared !== 0) return compared;
  }
  return 0;
}

function uniqueTuples(items, dimensions, view) {
  const values = new Map();
  for (const item of items) {
    const current = tuple(item, dimensions);
    values.set(tupleKey(current), current);
  }
  return [...values.values()].sort((left, right) =>
    compareTuple(left, right, dimensions, view),
  );
}

function splitTitle(values, view) {
  return values
    .map(
      (value, index) =>
        `${dimensionTitle(view, view.splitBy[index])}: ${
          tupleLabels([value], [view.splitBy[index]], view)[0]
        }`,
    )
    .join(" / ");
}

function renderTable(items, view) {
  const rows = uniqueTuples(items, view.rows, view);
  const columns = uniqueTuples(items, view.columns, view);
  assert(
    rows.length <= view.maxRows,
    `view ${view.id} has ${rows.length} rows, exceeding max-rows ${view.maxRows}`,
  );

  const cells = new Map();
  for (const item of items) {
    const rowKey = tupleKey(tuple(item, view.rows));
    const columnKey = tupleKey(tuple(item, view.columns));
    const key = `${rowKey}\n${columnKey}`;
    assert(!cells.has(key), `view ${view.id} has duplicate cell ${key}`);
    cells.set(key, item);
  }

  const header = view.rows.map((dimension) => dimensionTitle(view, dimension));
  for (const column of columns) {
    const labels = tupleLabels(column, view.columns, view);
    header.push(labels.join(" / "), "vs main");
  }
  const lines = [
    `| ${header.map(tableCell).join(" | ")} |`,
    `|${view.rows.map(() => "---").join("|")}|${columns
      .map(() => "---:|---:")
      .join("|")}|`,
  ];
  for (const row of rows) {
    const values = tupleLabels(row, view.rows, view).map(tableCell);
    for (const column of columns) {
      const key = `${tupleKey(row)}\n${tupleKey(column)}`;
      const item = cells.get(key);
      if (!item) {
        assert(
          view.missing === "blank",
          `view ${view.id} is missing cell ${key}`,
        );
        values.push("-", "-");
        continue;
      }
      values.push(
        formatValue(item.value, item.dimensions.metric.key, view),
        delta(item.value, item.baseline, item.better),
      );
    }
    lines.push(`| ${values.map(tableCell).join(" | ")} |`);
  }
  return lines;
}

function renderView(view, allItems) {
  const selected = allItems.filter((item) => view.matches(item));
  if (selected.length === 0) {
    assert(view.empty === "hide", `view ${view.id} has no matching results`);
    return [];
  }
  const splits =
    view.splitBy.length === 0
      ? [[]]
      : uniqueTuples(selected, view.splitBy, view);
  const body = [];
  for (const split of splits) {
    const items =
      view.splitBy.length === 0
        ? selected
        : selected.filter(
            (item) => tupleKey(tuple(item, view.splitBy)) === tupleKey(split),
          );
    if (split.length > 0)
      body.push(`#### ${markdown(splitTitle(split, view))}`, "");
    body.push(...renderTable(items, view), "");
  }

  if (!view.collapsed) {
    return [`### ${markdown(view.title)}`, "", ...body];
  }
  return [
    "<details>",
    `<summary>${markdown(view.title)}</summary>`,
    "",
    ...body,
    "</details>",
    "",
  ];
}

function renderViews(config, current, baseline) {
  const items = observations(config, current, baseline);
  return Object.values(config.views).flatMap((view) => renderView(view, items));
}

module.exports = { renderViews };
