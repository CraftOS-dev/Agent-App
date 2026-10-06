// PocketBase hooks are CommonJS/Goja source inside an ESM workspace package.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
process.argv.push("--selftest");
runInNewContext(readFileSync(join(__dirname, "../template/pb/pb_hooks/_a2app_rules.js"), "utf8"), {
  module: { exports: {} }, require, process, console,
});
