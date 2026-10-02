/**
 * The agent-state gate: work an app queues for an agent has to be visible in
 * the View until it is done.
 *
 * Standard library only, run directly, so `pnpm -r test` needs no test runner.
 *
 * Three things are pinned down here, and each one is a failure that would
 * otherwise look like success:
 *
 *   EVERY STACK'S SPELLING IS SEEN. A trigger that queues work is written five
 *   ways across the blueprints (positional, Python's keyword, Rust's Some(...),
 *   the adapter's object form). One the scanner misses is a feature the gate
 *   waves through.
 *
 *   ONLY QUEUED WORK COUNTS. A trigger with no capability announces an event
 *   and hands no agent anything, and a comment, a string or the definition of
 *   `trigger` is not a call. Failing those would make the gate noise.
 *
 *   SHIPPING THE COMPONENT IS NOT USING IT. Every blueprint ships the agent-task
 *   component, and it reads the task endpoint itself. If its own file counted,
 *   every app would pass.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(resolve(here, "..", "dist", "lib", "agentState.js")).href);
const { agentStateProblem, findQueuingTriggers, scanAgentState, strip } = lib;
const repoRoot = resolve(here, "..", "..", "..");

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
  else console.log(`  ok   ${label}`);
};

/** Capabilities found in one source string. */
const caps = (src, lang = "c") => {
  const s = strip(src, lang);
  return findQueuingTriggers(s.noComments, s.codeOnly).map((t) => t.capability);
};

/* ----------------------------------------------- every stack's spelling */

check("JS: positional capability", caps(`const { taskId } = trigger("task.needs_triage", { task: task.id }, "triage");`), ['"triage"']);
check("Go: store.trigger with M{}", caps(`fired, err := store.trigger("x.y", M{"task": task["id"]}, "review")`), ['"review"']);
check("Ruby: hash payload, next line opens a hash", caps(`fired = store.trigger("x.y", { "task" => task["id"] }, "triage")\n      { "ok" => true }`, "hash"), ['"triage"']);
check("Python: capability by keyword", caps(`fired = store.trigger("x.y", {"task": rec["id"]}, capability="review")`, "hash"), ['"review"']);
check("Rust: Some(capability)", caps(`let fired = store.trigger("x.y", &json!({ "task": id }), Some("review"))?;`), ['"review"']);
check("adapter object form", caps(`a2app.trigger({ type: "x.y", payload: { id }, capability: "review" })`), ['"review"']);
check("a variable capability still queues", caps(`trigger("x.y", payload, cap)`), ["cap"]);
check("a call spanning lines", caps(`trigger(\n  "x.y",\n  { task: id }, // which one\n  "triage",\n)`), ['"triage"']);
{
  const s = strip(`// header\n\nconst a = 1;\nconst r = trigger("x", {}, "c");`, "c");
  check("the line number is the call's", findQueuingTriggers(s.noComments, s.codeOnly).map((t) => t.line), [4]);
}

/* ------------------------------------------------ only queued work counts */

check("no capability: an announcement", caps(`trigger("x.y", { task: id })`), []);
check("empty capability (Go)", caps(`store.trigger("x.y", M{}, "")`), []);
check("None capability (Python)", caps(`store.trigger("x.y", {}, capability=None)`, "hash"), []);
check("nil capability (Ruby)", caps(`store.trigger("x.y", {}, nil)`, "hash"), []);
check("None capability (Rust)", caps(`store.trigger("x.y", &json!({}), None)?`), []);
check("in a line comment", caps(`// trigger("x.y", { task: id }, "triage")`), []);
check("in a block comment", caps(`/* trigger("x.y", {}, "triage") */`), []);
check("in a hash comment", caps(`# store.trigger("x.y", {}, "triage")`, "hash"), []);
check("in a string", caps(`const doc = 'call trigger("x", {}, "c") to queue';`), []);
check("in a Python docstring", caps(`"""\nstore.trigger("x", {}, capability="c")\n"""`, "hash"), []);
check("def trigger (Python)", caps(`def trigger(self, etype, payload, capability=None):`, "hash"), []);
check("fn trigger (Rust)", caps(`pub fn trigger(&mut self, etype: &str, payload: &Value, capability: Option<&str>) -> R {`), []);
check("Go method definition", caps(`func (s *Store) trigger(etype string, payload M, capability string) (M, error) {`), []);
check("JS method shorthand", caps(`trigger(type, payload, capability) {\n  return 1;\n}`), []);
check("a longer name is not trigger", caps(`retrigger("x", {}, "c"); my_trigger("x", {}, "c")`), []);

/* ------------------------------------------- the verdict on a whole app */

const base = mkdtempSync(join(tmpdir(), "a2app-agent-state-"));
const app = (name, files) => {
  const dir = join(base, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return scanAgentState(dir);
};
const RUNNER = `export const runners = { ask: (a, c, { trigger }) => trigger("x.y", { id: a.id }, "triage") };\n`;
const KIT = `/** shared piece — @a2app-kit agent-task */\nexport const f = (id) => fetch("/api/_a2app/tasks/" + id);\nexport function AgentTaskPanel() {}\n`;

try {
  {
    const r = app("silent", { "schema.mjs": RUNNER, "index.html": "<div id=app></div>", "src/App.jsx": "export default () => <button>Ask</button>;" });
    check("queued work + a View that ignores it: fails", agentStateProblem(r) !== null, true);
    const msg = agentStateProblem(r) ?? "";
    check("…naming the call site", msg.includes("schema.mjs:1"), true);
    check("…and pointing at the skill rule", msg.includes("The UI that queues work must show that work until it is done"), true);
  }
  {
    const r = app("shipped-not-used", { "schema.mjs": RUNNER, "src/AgentTask.jsx": KIT, "src/App.jsx": "export default () => <button>Ask</button>;" });
    check("the kit component alone does not count", agentStateProblem(r) !== null, true);
  }
  {
    const r = app("uses-component", {
      "schema.mjs": RUNNER,
      "src/AgentTask.jsx": KIT,
      "src/App.jsx": `import { AgentTaskPanel } from "./AgentTask.jsx";\nexport default ({ r }) => <AgentTaskPanel taskId={r.agentTask} />;`,
    });
    check("rendering the component passes", agentStateProblem(r), null);
  }
  {
    const r = app("polls-itself", { "schema.mjs": RUNNER, "src/App.jsx": "const t = await api(`/api/_a2app/tasks/${id}`);\nexport default () => <p>{t.status}</p>;" });
    check("following the task endpoint by hand passes", agentStateProblem(r), null);
  }
  {
    const r = app("comment-only", { "schema.mjs": RUNNER, "src/App.jsx": "// TODO: poll /api/_a2app/tasks and render AgentTaskPanel\nexport default () => <p />;" });
    check("a comment promising to follow it does not count", agentStateProblem(r) !== null, true);
  }
  {
    const r = app("vue", {
      "lib/schema.rb": `fired = store.trigger("x.y", { "task" => id }, "triage")\n`,
      "ui/src/components/AgentTaskPanel.vue": `<!-- @a2app-kit agent-task -->\n<script setup>\nimport { useAgentTask } from "../agentTask.js";\n</script>`,
      "ui/src/App.vue": `<!-- <AgentTaskPanel/> in a comment -->\n<template><p /></template>`,
    });
    check("Vue: a commented-out component does not count", agentStateProblem(r) !== null, true);
  }
  {
    const r = app("vue-ok", {
      "lib/schema.rb": `fired = store.trigger("x.y", { "task" => id }, "triage")\n`,
      "ui/src/App.vue": `<script setup>\nimport AgentTaskPanel from "./components/AgentTaskPanel.vue";\n</script>\n<template><AgentTaskPanel :task-id="t.agentTask" /></template>`,
    });
    check("Vue: rendering the component passes", agentStateProblem(r), null);
  }
  {
    const r = app("no-view", { "schema.py": `fired = store.trigger("x.y", {"task": 1}, capability="triage")\n`, "main.py": "app = 1\n" });
    check("no human View: nothing to show it in, so no verdict", [r.triggers.length, r.viewFiles.length, agentStateProblem(r)], [1, 0, null]);
  }
  {
    const r = app("announce-only", { "schema.mjs": `trigger("x.y", { id })\n`, "src/App.jsx": "export default () => <p />;" });
    check("triggers without a capability need no display", agentStateProblem(r), null);
  }
  {
    const r = app("system-owned", {
      ".a2app/system-hashes.json": JSON.stringify({ "server.mjs": "sha256:x" }),
      "server.mjs": `const t = a2app.trigger({ type, payload, capability: "c" });\n`,
      "src/App.jsx": "export default () => <p />;",
    });
    check("system-owned files are the framework's, not the app's", r.triggers.length, 0);
  }
  {
    const r = app("deps-and-tests", {
      "node_modules/pkg/index.js": RUNNER,
      "dist/assets/app.js": RUNNER,
      "test/ask.test.mjs": RUNNER,
      "src/App.jsx": "export default () => <p />;",
    });
    check("dependencies, build output and tests are not scanned", r.triggers.length, 0);
  }

  /* ------------------------------- the shipped starters pass their own gate */

  for (const [id, wantFollowers] of [
    ["blueprint-react-node", true],
    ["blueprint-go-react", true],
    ["blueprint-rust-react", true],
    ["blueprint-rails-vue", true],
    ["blueprint-python-fastapi", false],
  ]) {
    // A raw template has no ownership canon yet; the toolkit's systemPaths are
    // what scaffolding records in it.
    const tk = JSON.parse(readFileSync(join(repoRoot, "toolkits", id, "a2app.toolkit.json"), "utf8"));
    const r = scanAgentState(join(repoRoot, "toolkits", id, "template"), tk.systemPaths ?? []);
    check(`${id}: the starter queues work`, r.triggers.length > 0, true);
    check(`${id}: …and ${wantFollowers ? "its View shows it" : "has no View to show it in"}`, [r.followers.length > 0, agentStateProblem(r)], [wantFollowers, null]);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nagent-state gate: ${failures.length} check(s) failed\n`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log("\nagent-state gate: all checks passed");
