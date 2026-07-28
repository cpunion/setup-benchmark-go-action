"use strict";

const fs = require("node:fs");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJSON(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`read ${filename}: ${error.message}`, { cause: error });
  }
}

function readJSONIfExists(filename, fallback) {
  if (!fs.existsSync(filename)) return fallback;
  return readJSON(filename);
}

function writeJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(root, basename) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const pending = [root];
  while (pending.length !== 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`artifact contains symlink ${filename}`);
      }
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile() && entry.name === basename) found.push(filename);
    }
  }
  return found.sort();
}

function median(values) {
  assert(values.length !== 0, "cannot calculate an empty median");
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function safePart(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function hasControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeOutputs(filename, outputs) {
  if (!filename) return;
  let body = "";
  for (const [name, value] of Object.entries(outputs).sort()) {
    assert(
      !/[\r\n]/.test(name + value),
      `GitHub output ${name} contains a newline`,
    );
    body += `${name}=${value}\n`;
  }
  fs.appendFileSync(filename, body);
}

module.exports = {
  assert,
  compareText,
  hasControl,
  median,
  readJSON,
  readJSONIfExists,
  safePart,
  walkFiles,
  writeJSON,
  writeOutputs,
};
