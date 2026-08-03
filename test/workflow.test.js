"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const workflow = YAML.parse(
  fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "publish.yml"),
    "utf8",
  ),
);
const steps = workflow.jobs.publish.steps;
const step = (name) => steps.find((candidate) => candidate.name === name);

test("publisher exposes an optional data repository dispatch event", () => {
  const input = workflow.on.workflow_call.inputs.data_dispatch_event;
  assert.equal(input.required, undefined);
  assert.equal(input.default, "");
  assert.equal(input.type, "string");
});

test("data publishing failures degrade to a commented preview", () => {
  for (const name of [
    "Check out writable benchmark data",
    "Commit benchmark data",
    "Notify benchmark data repository",
  ]) {
    assert.equal(step(name)["continue-on-error"], true, name);
  }
  assert.equal(step("Require external data token"), undefined);
  assert.match(
    step("Check out public benchmark data for preview").if,
    /data-checkout\.outcome != 'success'/u,
  );
  assert.match(
    step("Check out public benchmark data for preview").run,
    /else\s+rm -rf "\$GITHUB_WORKSPACE\/benchmark-data"\s+mkdir benchmark-data/u,
  );
  assert.match(
    step("Add publishing status to report").run,
    /Persistent publishing is unavailable/u,
  );
});

test("benchmark validation and rendering remain hard failures", () => {
  for (const name of [
    "Download platform artifacts",
    "Check out trusted benchmark configuration for fork",
    "Render benchmark history",
    "Upload rendered preview",
    "Create or update PR comment",
  ]) {
    assert.notEqual(step(name)["continue-on-error"], true, name);
  }
});

test("publisher pins paired baselines to trusted pull request metadata", () => {
  const classify = step("Classify source series").run;
  assert.match(
    classify,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{PR_NUMBER\}"/u,
  );
  assert.match(classify, /\.base\.repo\.full_name/u);
  assert.match(classify, /\.base\.sha/u);
  const render = step("Render benchmark history");
  assert.equal(render.uses, "xgo-dev/setup-benchmark-go-action/publish@v1");
  assert.match(
    render.with["expected-baseline-repository"],
    /steps\.source\.outputs\.base-repository/u,
  );
  assert.match(
    render.with["expected-baseline-sha"],
    /steps\.source\.outputs\.base-sha/u,
  );
});
