"use strict";

function markdown(value) {
  return String(value).replace(/[\\*_[\]#`]/gu, "\\$&");
}

function tableCell(value) {
  return markdown(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatNumber(value) {
  if (Number.isInteger(value) && value < 1e12) return String(value);
  return value.toFixed(3);
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

module.exports = { delta, formatNumber, markdown, tableCell };
