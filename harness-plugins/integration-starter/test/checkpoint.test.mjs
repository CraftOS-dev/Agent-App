/**
 * Build checkpoints from a manager tab: the routes it serves (`CheckpointApi`)
 * to show the builder's questions or Part A and record the person's reply,
 * checked against the fake CLI — what they ask of it and how they read its
 * answers. Also the row's `checkpoint`, and a manager build's kickoff.
 *
 * Runs against the compiled engine (`dist/`), standard library only.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "a2app-starter-checkpoint-"));
const bin = join(base, "bin");
mkdirSync(bin);
copyFileSync(join(here, "fake-cli.mjs"), join(bin, "agent-app.mjs"));
const AGENT_APP = join(bin, "agent-app.mjs");
process.env.FAKE_CALLS = join(base, "calls.jsonl");
process.env.FAKE_REGISTRY = join(base, "registry.json");
process.env.FAKE_CHECKPOINT = join(base, "checkpoint.json");

const { BUILD_PANEL_NOTE, buildKickoffPrompt, CheckpointApi, checkpointWaiting, listKnownApps, parseCheckpoint } = await import("../dist/index.js");

const APP = "/apps/ledger";
const pending = (kind) => ({ id: "c-0000000a", kind, round: 1, status: "pending", shown: "ui", createdAt: "2026-11-17T00:00:00.000Z" });
const setCheckpoint = (c) => writeFileSync(process.env.FAKE_CHECKPOINT, JSON.stringify(c));
const calls = () => readFileSync(process.env.FAKE_CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
writeFileSync(process.env.FAKE_REGISTRY, JSON.stringify({ ok: true, apps: [{ id: "a1", name: "Ledger", path: APP, checkpoint: pending("questions") }, { id: "a2", name: "Plain", path: "/apps/plain", checkpoint: null }] }));

try {
  /* ── The row's checkpoint ── */
  const [ledger, plain] = await listKnownApps(AGENT_APP);
  assert.deepEqual(ledger.checkpoint, pending("questions"), "a row carries the checkpoint");
  assert.equal(plain.checkpoint, null);
  assert.equal(parseCheckpoint({ id: "c-1", kind: "interview", status: "pending" }), null, "an unknown kind is no checkpoint");
  assert.equal(parseCheckpoint({ id: "c-1", kind: "review", status: "pending" }).shown, "chat", "unmarked is chat");
  assert.ok(checkpointWaiting(pending("review")), "a pending panel checkpoint is shown");
  assert.ok(!checkpointWaiting({ ...pending("review"), shown: "chat" }), "a chat one is not");
  assert.ok(!checkpointWaiting({ ...pending("review"), status: "approved" }), "nor a decided one");

  /* ── Kickoff ── */
  const kick = buildKickoffPrompt({ action: "build", name: "Ledger", requirement: "Track spend." }, { checkpoints: "ui" });
  assert.ok(kick.prompt.endsWith(BUILD_PANEL_NOTE), "a manager build tells the builder about its panel");
  assert.match(kick.prompt, /--checkpoints ui/);
  assert.ok(!buildKickoffPrompt({ action: "build", name: "Ledger", requirement: "Track spend." }).prompt.includes(BUILD_PANEL_NOTE), "a pasted kickoff does not");

  const api = new CheckpointApi(AGENT_APP, "OpenClaw");

  /* ── Show ── */
  setCheckpoint(pending("questions"));
  let reply = await api.show(APP);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.checkpoint.id, "c-0000000a");
  assert.deepEqual(calls().at(-1).argv, [APP, "checkpoint", "show"]);
  assert.equal((await api.show("/apps/elsewhere")).status, 404, "only an app on this machine");
  assert.equal((await api.show(undefined)).status, 404);

  /* ── Answers ── */
  reply = await api.answer({ app: APP, id: "c-other", answers: [] });
  assert.deepEqual([reply.status, reply.body.reason], [409, "moved"], "a reply to a checkpoint the build moved past");
  reply = await api.answer({ app: APP, id: "c-0000000a" });
  assert.equal(reply.status, 400, "nothing to record");
  const answers = [{ id: "who", choices: ["Just me"] }];
  reply = await api.answer({ app: APP, id: "c-0000000a", answers });
  assert.equal(reply.status, 200);
  assert.deepEqual(calls().at(-1).argv, [APP, "checkpoint", "answer", "--json", JSON.stringify({ answers })]);
  assert.equal(reply.body.message, `answer: ${JSON.stringify({ answers })}`, "the person's message, as the CLI wrote it");
  assert.equal(reply.body.checkpoint.status, "answered");
  assert.equal((await api.answer({ app: APP, id: "c-0000000a", answers })).status, 409, "answered once");

  /* ── Review ── */
  setCheckpoint(pending("review"));
  reply = await api.show(APP);
  assert.match(reply.body.partA, /F-A-1/, "Part A to render");
  reply = await api.answer({ app: APP, id: "c-0000000a", changes: "  Add due dates.  ", partA: "# Edited\n" });
  assert.equal(reply.status, 200);
  const changeArgv = calls().at(-1).argv;
  assert.deepEqual(changeArgv.slice(0, 5), [APP, "checkpoint", "answer", "--changes", "Add due dates."]);
  assert.equal(changeArgv[5], "--part-a");
  assert.equal(reply.body.message, "answer: Add due dates. (edited: # Edited\n)", "the edit travels as a file");
  assert.ok(!existsSync(changeArgv[6]), "…which is gone afterwards");

  setCheckpoint(pending("review"));
  reply = await api.approve({ app: APP, id: "c-0000000a", partA: "<REPLACE: x>" });
  assert.deepEqual([reply.status, reply.body.reason, reply.body.problems.length], [422, "part_a_incomplete", 1], "an incomplete edit says what is wrong");
  reply = await api.approve({ app: APP, id: "c-0000000a" });
  assert.equal(reply.status, 200);
  assert.deepEqual(calls().at(-1).argv, [APP, "checkpoint", "approve", "--by", "OpenClaw"], "approved in the harness's name");
  assert.equal(reply.body.checkpoint.status, "approved");
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log("✓ checkpoint: rows, kickoff, show, answers, change requests with edits, approval");
