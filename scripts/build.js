"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ncc = require("@vercel/ncc");

const root = path.resolve(__dirname, "..");
const builds = [
  ["src/record-action.js", "dist"],
  ["src/render-action.js", "publish/dist"],
];

async function build(entry, output) {
  const outputDirectory = path.join(root, output);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  const result = await ncc(path.join(root, entry), { minify: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "index.js"), result.code);
  for (const [name, asset] of Object.entries(result.assets)) {
    const filename = path.join(outputDirectory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, asset.source, { mode: asset.permissions });
  }
  console.log(`${entry} -> ${output}/index.js`);
}

async function main() {
  for (const [entry, output] of builds) await build(entry, output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
