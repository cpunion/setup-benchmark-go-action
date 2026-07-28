"use strict";

const { runRecord, runRender } = require("./commands");

function main(args) {
  const [command, ...rest] = args;
  if (command === "record") return runRecord(rest);
  if (command === "render") return runRender(rest);
  throw new Error(
    `expected record or render command, got ${JSON.stringify(command)}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`setup-benchmark-go: ${error.message}`);
  process.exitCode = 1;
}
