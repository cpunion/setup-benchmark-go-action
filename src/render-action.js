"use strict";

const path = require("node:path");
const { runRender } = require("./commands");

function workspacePath(value) {
  return path.isAbsolute(value)
    ? value
    : path.join(process.env.GITHUB_WORKSPACE || process.cwd(), value);
}

function input(name) {
  const key = `BENCHMARK_${name.replaceAll("-", "_").toUpperCase()}`;
  return process.env[key] ?? "";
}

function add(args, name, value) {
  if (value) args.push(`--${name}`, value);
}

function run() {
  const args = [
    "--artifacts",
    workspacePath(input("artifacts")),
    "--data-dir",
    workspacePath(input("data-directory")),
    "--series-kind",
    input("series-kind"),
    "--series-id",
    input("series-id"),
    "--series-label",
    input("series-label"),
    "--comment",
    workspacePath(input("comment-path")),
  ];
  add(args, "additional-series-kind", input("additional-series-kind"));
  add(args, "additional-series-id", input("additional-series-id"));
  add(args, "additional-series-label", input("additional-series-label"));
  add(args, "site-base-url", input("site-base-url"));
  return runRender(args);
}

module.exports = { run };
