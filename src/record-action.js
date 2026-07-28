"use strict";

const path = require("node:path");
const { runRecord } = require("./commands");

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
    "--config",
    workspacePath(input("config")),
    "--input",
    workspacePath(input("benchmark-file")),
  ];
  add(args, "platform-id", input("platform-id"));
  add(args, "platform-label", input("platform-label"));
  add(args, "shard-id", input("shard-id"));
  return runRecord(args);
}

module.exports = { run, workspacePath };
