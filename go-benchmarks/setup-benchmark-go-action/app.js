"use strict";

const state = { config: null, index: null, history: null, charts: [], kind: "", group: "", series: null };
const el = {};

function byId(id) { return document.getElementById(id); }
function keyOf(bench) { return bench.package ? `${bench.package}::${bench.name}` : bench.name; }
function titleForGroup(id) {
  if (id === "other") return "Other";
  return state.config.groups?.[id]?.title || id;
}
function destroyCharts() {
  for (const chart of state.charts) chart.destroy();
  state.charts = [];
  el.charts.replaceChildren();
}
function button(text, selected, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.setAttribute("aria-selected", String(selected));
  node.addEventListener("click", onClick);
  return node;
}
function latestEntry() {
  const entries = state.history?.entries || [];
  return entries[entries.length - 1];
}
function renderKinds() {
  const kinds = [...new Set(state.index.series.map((item) => item.kind))];
  el.kindTabs.replaceChildren(...kinds.map((kind) => button(
    kind === "pull" ? "Pull requests" : kind === "branch" ? "Branches" : "Main",
    kind === state.kind,
    () => { state.kind = kind; renderKinds(); renderSeriesOptions(); },
  )));
}
function renderSeriesOptions() {
  const choices = state.index.series.filter((item) => item.kind === state.kind);
  el.series.replaceChildren(...choices.map((item) => {
    const option = document.createElement("option");
    option.value = `${item.kind}/${item.id}`;
    option.textContent = item.label;
    return option;
  }));
  const selected = choices.find((item) => item.kind === state.series?.kind && item.id === state.series?.id) || choices[0];
  if (selected) loadSeries(selected);
}
async function loadSeries(series) {
  state.series = series;
  el.series.value = `${series.kind}/${series.id}`;
  const [historyResponse, configResponse] = await Promise.all([
    fetch(series.path, { cache: "no-store" }),
    fetch(series.configPath, { cache: "no-store" }),
  ]);
  if (!historyResponse.ok) throw new Error(`history returned HTTP ${historyResponse.status}`);
  if (!configResponse.ok) throw new Error(`config returned HTTP ${configResponse.status}`);
  state.history = await historyResponse.json();
  state.config = await configResponse.json();
  const latest = latestEntry();
  el.title.textContent = state.config.title;
  el.repository.textContent = latest?.source.repository || "Source repository";
  el.repository.href = latest?.source.repository
    ? `https://github.com/${latest.source.repository}`
    : "";
  el.seriesKind.textContent = series.kind === "pull" ? "Pull request" : series.kind;
  el.seriesTitle.textContent = series.label;
  el.commit.textContent = series.sha.slice(0, 12);
  el.commit.href = series.sourceUrl;
  const platformMap = new Map();
  for (const entry of state.history.entries || []) {
    for (const result of Object.values(entry.platforms || {})) {
      platformMap.set(result.platform.id, result.platform);
    }
  }
  const platforms = [...platformMap.values()];
  const previousPlatform = el.platform.value;
  el.platform.replaceChildren(...platforms.sort((a, b) => a.id.localeCompare(b.id)).map((platform) => {
    const option = document.createElement("option");
    option.value = platform.id;
    option.textContent = platform.label;
    return option;
  }));
  if (platformMap.has(previousPlatform)) el.platform.value = previousPlatform;
  renderGroups();
  updateURL();
}
function groupIDs() {
  const configured = Object.keys(state.config.groups || {}).sort();
  const seenOther = (state.history?.entries || []).some((entry) =>
    Object.values(entry.platforms || {}).some((result) => result.benchmarks.some((bench) => bench.group === "other")));
  return seenOther ? [...configured, "other"] : configured;
}
function renderGroups() {
  const groups = groupIDs();
  if (!groups.includes(state.group)) state.group = groups[0] || "other";
  el.groupTabs.replaceChildren(...groups.map((group) => button(
    titleForGroup(group),
    group === state.group,
    () => { state.group = group; renderGroups(); },
  )));
  renderCharts();
}
function renderCharts() {
  destroyCharts();
  const platform = el.platform.value;
  const entries = state.history?.entries || [];
  const units = new Set();
  for (const entry of entries) {
    for (const bench of entry.platforms?.[platform]?.benchmarks || []) {
      if (bench.group === state.group) Object.keys(bench.measurements).forEach((unit) => units.add(unit));
    }
  }
  for (const unit of [...units].sort()) renderChart(entries, platform, unit);
  el.empty.hidden = state.charts.length !== 0;
}
function renderChart(entries, platform, unit) {
  const names = new Set();
  for (const entry of entries) {
    for (const bench of entry.platforms?.[platform]?.benchmarks || []) {
      if (bench.group === state.group && Number.isFinite(bench.measurements?.[unit])) names.add(keyOf(bench));
    }
  }
  if (names.size === 0) return;
  const card = document.createElement("article");
  card.className = "chart";
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  heading.textContent = titleForGroup(state.group);
  const meta = document.createElement("span");
  const latest = [...entries].reverse().find((entry) => entry.platforms?.[platform]);
  const better = latest?.platforms?.[platform]?.units?.[unit]?.better;
  const direction = better ? ` · ${better} is better` : "";
  meta.textContent = `${el.platform.selectedOptions[0]?.textContent || platform} · ${unit}${direction}`;
  header.append(heading, meta);
  const frame = document.createElement("div");
  frame.className = "frame";
  const canvas = document.createElement("canvas");
  frame.append(canvas);
  card.append(header, frame);
  el.charts.append(card);
  const colors = ["#236b5b", "#c44b35", "#3f6fb5", "#8d5ca6", "#9a741e", "#2f7f91", "#6a7b3d", "#b34f7a"];
  const datasets = [...names].sort().map((name, index) => ({
    label: name,
    data: entries.map((entry) => {
      const bench = (entry.platforms?.[platform]?.benchmarks || []).find((item) => keyOf(item) === name);
      return bench?.measurements?.[unit] ?? null;
    }),
    borderColor: colors[index % colors.length],
    backgroundColor: colors[index % colors.length],
    borderWidth: 2,
    pointRadius: entries.length <= 2 ? 3 : 1.5,
    tension: 0.12,
    spanGaps: true,
  }));
  state.charts.push(new Chart(canvas, {
    type: "line",
    data: { labels: entries.map((entry) => entry.source.sha.slice(0, 8)), datasets },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { align: "start", position: "bottom" } },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: "commit" } },
        y: { beginAtZero: true, title: { display: true, text: unit } },
      },
    },
  }));
}
function updateURL() {
  const url = new URL(location.href);
  url.searchParams.set("series", `${state.series.kind}/${state.series.id}`);
  history.replaceState(null, "", url);
}
async function start() {
  Object.assign(el, {
    title: byId("title"), repository: byId("repository"), kindTabs: byId("kind-tabs"),
    series: byId("series"), platform: byId("platform"), seriesKind: byId("series-kind"),
    seriesTitle: byId("series-title"), commit: byId("commit"), groupTabs: byId("group-tabs"),
    charts: byId("charts"), empty: byId("empty"),
  });
  const indexResponse = await fetch("series.json", { cache: "no-store" });
  if (!indexResponse.ok) throw new Error(`series index returned HTTP ${indexResponse.status}`);
  state.index = await indexResponse.json();
  const requested = new URLSearchParams(location.search).get("series");
  state.series = state.index.series.find((item) => `${item.kind}/${item.id}` === requested) || state.index.series[0];
  if (!state.series) throw new Error("No benchmark series has been published yet.");
  state.kind = state.series?.kind || "main";
  renderKinds();
  renderSeriesOptions();
  el.series.addEventListener("change", () => {
    const selected = state.index.series.find((item) => `${item.kind}/${item.id}` === el.series.value);
    if (selected) loadSeries(selected);
  });
  el.platform.addEventListener("change", renderCharts);
}
start().catch((error) => {
  byId("empty").hidden = false;
  byId("empty").textContent = error.message;
});
