"use strict";

const { RE2JS } = require("re2js");
const { assert, hasControl, safePart } = require("./util");

const dimensions = new Set([
  "platform",
  "package",
  "group",
  "benchmark",
  "metric",
]);
const formats = new Set([
  "auto",
  "number",
  "bytes",
  "duration-ns",
  "duration-us",
  "duration-ms",
  "duration-s",
]);

function keys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${field} has unsupported field ${key}`);
  }
}

function text(value, field, max = 120) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max &&
      value.trim() === value &&
      !hasControl(value),
    `${field} must be a trimmed string of 1..${max} bytes`,
  );
  return value;
}

function stringList(value, field) {
  if (value === undefined || value === null || value === "") return [];
  const values = typeof value === "string" ? [value] : value;
  assert(
    Array.isArray(values) && values.every((item) => typeof item === "string"),
    `${field} must be a string or string list`,
  );
  return values;
}

function patterns(value, field) {
  return stringList(value, field).map((source) => {
    try {
      return { source, compiled: RE2JS.compile(source) };
    } catch (error) {
      throw new Error(
        `${field} pattern ${JSON.stringify(source)}: ${error.message}`,
        { cause: error },
      );
    }
  });
}

function dimensionList(value, fallback, field) {
  const result = value === undefined ? fallback : stringList(value, field);
  assert(result.length > 0, `${field} must not be empty`);
  const seen = new Set();
  for (const item of result) {
    assert(dimensions.has(item), `${field} has unsupported dimension ${item}`);
    assert(!seen.has(item), `${field} repeats dimension ${item}`);
    seen.add(item);
  }
  return result;
}

function parseDimensionOptions(raw, field) {
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    `${field} must be a mapping`,
  );
  const result = {};
  for (const [dimension, value] of Object.entries(raw)) {
    assert(dimensions.has(dimension), `${field} has unknown ${dimension}`);
    const options = typeof value === "string" ? { title: value } : value;
    assert(
      options && typeof options === "object" && !Array.isArray(options),
      `${field}.${dimension} must be a title or mapping`,
    );
    keys(options, new Set(["title", "trim-prefix"]), `${field}.${dimension}`);
    result[dimension] = {
      ...(options.title === undefined
        ? {}
        : { title: text(options.title, `${field}.${dimension}.title`) }),
      ...(options["trim-prefix"] === undefined
        ? {}
        : {
            trimPrefix: text(
              options["trim-prefix"],
              `${field}.${dimension}.trim-prefix`,
              300,
            ),
          }),
    };
  }
  return result;
}

function parseMetrics(raw, field) {
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    `${field} must be a mapping`,
  );
  const result = {};
  for (const [metric, value] of Object.entries(raw)) {
    const options = typeof value === "string" ? { title: value } : value;
    assert(
      metric.length > 0 && Buffer.byteLength(metric) <= 64,
      `${field} has invalid metric ${JSON.stringify(metric)}`,
    );
    assert(
      options && typeof options === "object" && !Array.isArray(options),
      `${field}.${metric} must be a title or mapping`,
    );
    keys(options, new Set(["title", "format"]), `${field}.${metric}`);
    const format = options.format ?? "auto";
    assert(
      formats.has(format),
      `${field}.${metric}.format has unsupported value ${format}`,
    );
    result[metric] = {
      title: text(options.title ?? metric, `${field}.${metric}.title`),
      format,
    };
  }
  return result;
}

function serializeDimensionOptions(values) {
  return Object.fromEntries(
    Object.entries(values).map(([dimension, options]) => [
      dimension,
      {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.trimPrefix === undefined
          ? {}
          : { "trim-prefix": options.trimPrefix }),
      },
    ]),
  );
}

class View {
  constructor(id, raw) {
    assert(
      safePart(id) && id === id.toLowerCase(),
      `invalid view id ${JSON.stringify(id)}`,
    );
    assert(
      raw && typeof raw === "object" && !Array.isArray(raw),
      `view ${id} must be a mapping`,
    );
    keys(raw, new Set(["title", "select", "table"]), `view ${id}`);
    this.id = id;
    this.title = text(raw.title ?? id, `view ${id} title`);

    const select = raw.select ?? {};
    assert(
      select && typeof select === "object" && !Array.isArray(select),
      `view ${id} select must be a mapping`,
    );
    keys(
      select,
      new Set(["platforms", "packages", "groups", "benchmarks", "metrics"]),
      `view ${id} select`,
    );
    this.select = {};
    this.compiledSelect = {};
    for (const dimension of [
      "platforms",
      "packages",
      "groups",
      "benchmarks",
      "metrics",
    ]) {
      const compiled = patterns(
        select[dimension],
        `view ${id} select.${dimension}`,
      );
      this.select[dimension] = compiled.map((item) => item.source);
      this.compiledSelect[dimension] = compiled.map((item) => item.compiled);
    }

    const table = raw.table ?? {};
    assert(
      table && typeof table === "object" && !Array.isArray(table),
      `view ${id} table must be a mapping`,
    );
    keys(
      table,
      new Set([
        "rows",
        "columns",
        "split-by",
        "collapsed",
        "missing",
        "empty",
        "max-rows",
        "dimensions",
        "metrics",
      ]),
      `view ${id} table`,
    );
    this.rows = dimensionList(
      table.rows,
      ["platform", "benchmark"],
      `view ${id} table.rows`,
    );
    this.columns = dimensionList(
      table.columns,
      ["metric"],
      `view ${id} table.columns`,
    );
    this.splitBy =
      table["split-by"] === undefined
        ? []
        : dimensionList(table["split-by"], [], `view ${id} table.split-by`);
    const used = new Set();
    for (const dimension of [...this.rows, ...this.columns, ...this.splitBy]) {
      assert(
        !used.has(dimension),
        `view ${id} uses dimension ${dimension} more than once`,
      );
      used.add(dimension);
    }
    this.collapsed = table.collapsed ?? false;
    assert(
      typeof this.collapsed === "boolean",
      `view ${id} table.collapsed must be boolean`,
    );
    this.missing = table.missing ?? "blank";
    assert(
      this.missing === "blank" || this.missing === "error",
      `view ${id} table.missing must be blank or error`,
    );
    this.empty = table.empty ?? "hide";
    assert(
      this.empty === "hide" || this.empty === "error",
      `view ${id} table.empty must be hide or error`,
    );
    this.maxRows = table["max-rows"] ?? 200;
    assert(
      Number.isInteger(this.maxRows) &&
        this.maxRows >= 1 &&
        this.maxRows <= 1000,
      `view ${id} table.max-rows must be between 1 and 1000`,
    );
    this.dimensionOptions = parseDimensionOptions(
      table.dimensions ?? {},
      `view ${id} table.dimensions`,
    );
    this.metrics = parseMetrics(
      table.metrics ?? {},
      `view ${id} table.metrics`,
    );
  }

  matches(observation) {
    const candidates = {
      platforms: [
        observation.dimensions.platform.key,
        observation.dimensions.platform.label,
      ],
      packages: [observation.dimensions.package.key],
      groups: [
        observation.dimensions.group.key,
        observation.dimensions.group.label,
      ],
      benchmarks: [
        observation.dimensions.benchmark.key,
        observation.dimensions.benchmark.label,
        observation.dimensions.benchmark.label.replace(/^Benchmark/u, ""),
      ],
      metrics: [observation.dimensions.metric.key],
    };
    return Object.entries(this.compiledSelect).every(
      ([field, compiled]) =>
        compiled.length === 0 ||
        compiled.some((pattern) =>
          candidates[field].some((value) => pattern.matcher(value).find()),
        ),
    );
  }

  toJSON() {
    return {
      title: this.title,
      select: Object.fromEntries(
        Object.entries(this.select).filter(([, values]) => values.length > 0),
      ),
      table: {
        rows: this.rows,
        columns: this.columns,
        ...(this.splitBy.length > 0 ? { "split-by": this.splitBy } : {}),
        collapsed: this.collapsed,
        missing: this.missing,
        empty: this.empty,
        "max-rows": this.maxRows,
        ...(Object.keys(this.dimensionOptions).length > 0
          ? { dimensions: serializeDimensionOptions(this.dimensionOptions) }
          : {}),
        ...(Object.keys(this.metrics).length > 0
          ? { metrics: this.metrics }
          : {}),
      },
    };
  }
}

function parseViews(raw) {
  if (raw === undefined || raw === null) return {};
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "views must be a mapping",
  );
  return Object.fromEntries(
    Object.entries(raw).map(([id, value]) => [id, new View(id, value)]),
  );
}

function serializeViews(views) {
  return Object.fromEntries(
    Object.entries(views).map(([id, view]) => [id, view.toJSON()]),
  );
}

module.exports = { parseViews, serializeViews };
