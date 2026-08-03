"use strict";

const path = require("node:path");
const { parseArgs } = require("node:util");
const { migrateLegacyData } = require("../src/store");

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "site-path": { type: "string" },
  },
  strict: true,
});
if (!values["data-dir"] || !values["site-path"]) {
  throw new Error("migrate-data requires --data-dir and --site-path");
}
const migrated = migrateLegacyData(
  path.resolve(values["data-dir"]),
  values["site-path"],
);
console.log(
  `Migrated ${migrated.series} series and ${migrated.commits} commits under ${migrated.siteRoot}`,
);
