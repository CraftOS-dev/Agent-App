/**
 * readJsonFile + the canon's byte-drift diagnosis: the two halves of one bug.
 *
 * A `manifest.json` written by PowerShell 5's `Set-Content -Encoding utf8` (or
 * saved by Notepad as "UTF-8 with BOM") starts with U+FEFF. Every framework
 * command parsed it with a bare `JSON.parse(readFileSync(...))`, which failed
 * with `Unexpected token '﻿', "﻿{...` — an invisible character quoted back at
 * the user, no file name, nothing about encoding. And even once the parse was
 * tolerant, the ownership canon (byte-exact, as it must be) reported the same
 * file as "modified outside tooling", pointing at toolkit upgrades and agent
 * edits when the only change was three bytes of encoding.
 *
 * Standard library only, run directly, so `pnpm -r test` needs no test runner.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileError, parseJsonText, readJsonFile, stripBom } from "../dist/lib/json.js";
import { describeDrift, verifySystemHashes, writeSystemHashes } from "../dist/lib/canon.js";
import { validateManifest } from "../dist/lib/frameworkFiles.js";
import { loadProject } from "../dist/lib/project.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const checkIncludes = (label, haystack, needle) => {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    failures.push(`${label}\n    expected to include: ${JSON.stringify(needle)}\n    actual: ${JSON.stringify(haystack)}`);
  }
};

const BOM = "﻿";
const manifest = {
  id: "bomtest",
  name: "BOM test",
  agentAppVersion: "0.1.0",
  adapterVersion: "0.1.0",
  authMode: "none",
  port: 8099,
  modules: [{ name: "core", summary: "the one module" }],
  pipeline: { install: "true", build: "true", start: "true", health: "/" },
};
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

const root = mkdtempSync(join(tmpdir(), "a2app-json-file-"));
try {
  /* ---------------------------------------------------------- stripBom */

  check("stripBom removes a leading BOM", stripBom(`${BOM}{}`), "{}");
  check("stripBom leaves text without one alone", stripBom("{}"), "{}");
  check("stripBom only strips the first character", stripBom(`{"a":"${BOM}"}`), `{"a":"${BOM}"}`);

  /* ------------------------------------------------------ readJsonFile */

  const withBom = join(root, "with-bom.json");
  writeFileSync(withBom, BOM + manifestText, "utf8");
  check("readJsonFile parses a BOM-prefixed file", readJsonFile(withBom), manifest);

  const crlfBom = join(root, "crlf-bom.json");
  writeFileSync(crlfBom, BOM + manifestText.replace(/\n/g, "\r\n"), "utf8");
  check("readJsonFile parses BOM + CRLF (the full PowerShell 5 output)", readJsonFile(crlfBom), manifest);

  const broken = join(root, "broken.json");
  writeFileSync(broken, '{"id": "x",}\n', "utf8");
  let err = null;
  try {
    readJsonFile(broken);
  } catch (e) {
    err = e;
  }
  check("malformed JSON throws JsonFileError", err instanceof JsonFileError, true);
  check("...which is still an Error for existing catch sites", err instanceof Error, true);
  checkIncludes("...whose message names the file", err?.message, broken);
  check("...and exposes the path", err?.path, broken);
  check("...and the parser's own SyntaxError as cause", err?.cause instanceof SyntaxError, true);

  let textErr = null;
  try {
    parseJsonText("nope", "stdin");
  } catch (e) {
    textErr = e;
  }
  checkIncludes("parseJsonText names its label on failure", textErr?.message, "stdin: not valid JSON");

  /* ------------------------------------- the commands that read manifests */

  const app = join(root, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "manifest.json"), BOM + manifestText, "utf8");

  check("loadProject reads a BOM-prefixed manifest", loadProject(app).manifest.id, "bomtest");
  check("loadProject picks up the port through the BOM", loadProject(app).baseUrl, "http://127.0.0.1:8099");
  check("validateManifest passes a BOM-prefixed manifest", validateManifest(app), []);

  writeFileSync(join(app, "manifest.json"), BOM + '{"id": "x",}\n', "utf8");
  const problems = validateManifest(app);
  check("validateManifest still rejects real syntax errors", problems.length, 1);
  check("...under the file's name", problems[0]?.file, "manifest.json");
  checkIncludes("...saying it is not valid JSON, once", problems[0]?.message, "not valid JSON");
  check(
    "...without repeating the prefix readJsonFile adds",
    (problems[0]?.message.match(/not valid JSON/g) ?? []).length,
    1,
  );

  /* --------------------------------------------- canon byte-drift notes */

  // Record the canon from a clean LF, BOM-free manifest — what scaffold writes.
  writeFileSync(join(app, "manifest.json"), manifestText, "utf8");
  writeSystemHashes(app, ["manifest.json"]);
  check("clean canon: no drift", describeDrift(verifySystemHashes(app)), []);

  // Then let PowerShell 5 "save" it: same characters, BOM in front.
  writeFileSync(join(app, "manifest.json"), BOM + manifestText, "utf8");
  let drift = verifySystemHashes(app);
  check("a BOM still counts as modified (the canon stays byte-exact)", drift.modified, ["manifest.json"]);
  checkIncludes("...but the note names the byte-order mark", drift.notes["manifest.json"], "byte-order mark");
  checkIncludes("...and the tool that adds one", drift.notes["manifest.json"], "Set-Content -Encoding utf8");
  checkIncludes("...and the repair", drift.notes["manifest.json"], "toolkit-sync");
  checkIncludes("describeDrift prints the note on the modified line", describeDrift(drift)[0], "modified: manifest.json — only a UTF-8 byte-order mark");

  // A CRLF checkout of the same file.
  writeFileSync(join(app, "manifest.json"), manifestText.replace(/\n/g, "\r\n"), "utf8");
  drift = verifySystemHashes(app);
  checkIncludes("CRLF-only drift is named as line endings", drift.notes["manifest.json"], "only line endings differ");
  checkIncludes("...and points at .gitattributes", drift.notes["manifest.json"], ".gitattributes");

  // Both at once — PowerShell 5 writing on a CRLF checkout.
  writeFileSync(join(app, "manifest.json"), BOM + manifestText.replace(/\n/g, "\r\n"), "utf8");
  drift = verifySystemHashes(app);
  checkIncludes("BOM + CRLF names both", drift.notes["manifest.json"], "byte-order mark");
  checkIncludes("BOM + CRLF names both (2)", drift.notes["manifest.json"], "CRLF line endings");
  checkIncludes("BOM + CRLF names the tool that writes exactly that", drift.notes["manifest.json"], "Set-Content -Encoding utf8");

  // A real edit gets NO note: the ordinary "modified" message is the right one.
  writeFileSync(join(app, "manifest.json"), manifestText.replace("8099", "8100"), "utf8");
  drift = verifySystemHashes(app);
  check("a content change is plain 'modified'", drift.modified, ["manifest.json"]);
  check("...with no encoding note", drift.notes["manifest.json"], undefined);
  check("...printed as before", describeDrift(drift), ["modified: manifest.json"]);

  // An edit that ALSO carries a BOM is still an edit.
  writeFileSync(join(app, "manifest.json"), BOM + manifestText.replace("8099", "8100"), "utf8");
  drift = verifySystemHashes(app);
  check("BOM on top of a content change: no note (the content changed)", drift.notes["manifest.json"], undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`json-file: ${failures.length} failure(s)\n\n  ${failures.join("\n\n  ")}`);
  process.exit(1);
}
console.log("json-file: ok");
