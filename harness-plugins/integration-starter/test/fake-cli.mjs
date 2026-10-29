/**
 * A stand-in for the framework CLIs, for tests that check what a harness asks
 * of them and how it reads the answers — not what the CLI does (the CLI's own
 * suite covers that, and the starter's suite also drives the real one).
 *
 * Copy it as `agent-app.mjs` and `a2app.mjs`: it reports the binary it was run
 * as (its file name), and appends every call to `$FAKE_CALLS` when that is set.
 * It answers in the shapes of the packaging contract (framework packaging §8):
 *
 *   list --json          the registry in `$FAKE_REGISTRY`, else none
 *   catalogue            two apps; `--source unreachable` exits 3
 *   inspect              a report; a `--from` naming "living" or "foreign" is not a package
 *   install … --events   one step line per step (`$FAKE_STEP_MS` apart), then the result;
 *                        an id and --from together exit 2 with no JSON, as the CLI does
 *   anything else        `{ ok, bin, argv }`, and exit 1 when an argument is "BAD"
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const BIN = basename(process.argv[1]).replace(/\.mjs$/, "");
const argv = process.argv.slice(2);
if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ bin: BIN, argv, cwd: process.cwd() }) + "\n");

const out = (doc) => process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = ["acquire", "inspect", "sanitize", "revendor", "customize", "place", "register", "dependencies", "gate", "serve", "open"];

function kindOf(from) {
  if (from === undefined) return "agent-app";
  if (from.includes("living")) return "living-ui";
  if (from.includes("foreign")) return "foreign";
  return "agent-app";
}
const ROUTES = { "agent-app": [], "living-ui": ["convert"], foreign: ["adopt", "convert"] };

async function install() {
  const id = argv[1] !== undefined && !argv[1].startsWith("--") ? argv[1] : undefined;
  const from = flag("from");
  if ((id === undefined) === (from === undefined)) {
    process.stderr.write("✗ Name a catalogue id or --from <source>, not both\n");
    process.exit(2);
  }
  const events = argv.includes("--events");
  const emit = (line) => {
    if (events) process.stdout.write(JSON.stringify(line) + "\n");
  };
  const kind = kindOf(from);
  const trust = id !== undefined ? "catalogued" : "untrusted";
  const dir = `/apps/${flag("name") ?? id ?? "imported"}`;
  for (const step of STEPS) {
    if (step === "inspect" && kind !== "agent-app") {
      const reason = `a ${kind} source is not an Agent App package`;
      emit({ event: "step", step, status: "start" });
      emit({ event: "step", step, status: "failed", error: reason });
      const result = { ok: false, step, error: reason, kind, reason, routes: ROUTES[kind] };
      if (events) emit({ event: "result", ...result });
      else out(result);
      process.exit(1);
    }
    if ((step === "dependencies" || step === "serve") && argv.includes("--no-start")) {
      emit({ event: "step", step, status: "skipped", reason: "--no-start" });
      continue;
    }
    if (step === "open" && !argv.includes("--open")) {
      emit({ event: "step", step, status: "skipped", reason: "pass --open to show it to someone" });
      continue;
    }
    emit({ event: "step", step, status: "start" });
    await sleep(Number(process.env.FAKE_STEP_MS ?? 0));
    emit({ event: "step", step, status: "done" });
  }
  const served = !argv.includes("--no-start");
  const result = {
    ok: true,
    id: "0123456789ab",
    name: flag("name") ?? "Installed App",
    dir,
    port: 8123,
    ...(served ? { url: "http://127.0.0.1:8123/" } : {}),
    trust,
    source: id !== undefined ? { kind: "marketplace", catalogueId: id } : { kind: "zip", location: from },
    gate: { ok: true },
    served,
    next: trust === "untrusted" ? ["walk-verify: a verifier agent runs the walk-verify skill"] : [],
    bin: BIN,
    argv,
  };
  if (events) emit({ event: "result", ...result });
  else out(result);
}

if (BIN === "agent-app" && argv[0] === "list") {
  const file = process.env.FAKE_REGISTRY;
  process.stdout.write(file && existsSync(file) ? readFileSync(file, "utf8") : JSON.stringify({ ok: true, apps: [] }));
} else if (BIN === "agent-app" && argv[0] === "catalogue") {
  if (flag("source") === "unreachable") {
    process.stderr.write("✗ github:acme/unreachable is unreachable\n");
    process.exit(3);
  }
  out({
    ok: true,
    source: { kind: "github", location: "github:acme/market@main", repository: "acme/market", ref: "main" },
    apps: [
      {
        id: "kanban-board",
        name: "Kanban Board",
        description: "Tasks in columns",
        folder: "kanban-board",
        tags: ["productivity"],
        version: "1.0.0",
        customizable: [{ key: "APP_TITLE", label: "Board title", type: "text", default: "Kanban" }],
        compatible: true,
      },
      { id: "kanban-online", name: "Kanban Online", folder: "kanban-online", livingUIVersion: 2, compatible: false, reason: "a CraftBot Living UI app" },
    ],
    bin: BIN,
    argv,
  });
} else if (BIN === "agent-app" && argv[0] === "inspect") {
  const kind = kindOf(flag("from"));
  out({ ok: true, kind, installable: kind === "agent-app", reason: kind === "agent-app" ? null : `not a package (${kind})`, routes: ROUTES[kind], bin: BIN, argv });
} else if (BIN === "agent-app" && argv[0] === "install") {
  await install();
} else {
  out({ ok: !argv.includes("BAD"), bin: BIN, argv });
  if (argv.includes("BAD")) {
    process.stderr.write("rejected by the guard\n");
    process.exitCode = 1;
  }
}
