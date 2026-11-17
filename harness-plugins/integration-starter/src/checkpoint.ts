/**
 * Build checkpoints in a manager tab: the builder's questions, then the review
 * of Part A of the requirements, shown in the app's tab instead of chat.
 *
 * A build the manager starts scaffolds with `--checkpoints ui` (its kickoff
 * prompt says so), so the builder opens each checkpoint for the panel and ends
 * its turn. The panel finds it on the app's row (`checkpoint`, from
 * `agent-app list --json`), reads it, and records the person's reply through
 * the CLI, which returns the text to post into the build's session as the
 * person's message — the builder continues from that. The routes, independent
 * of how a harness serves HTTP:
 *
 *   GET  /checkpoint?app=<path>                                  what is open: the questions, or Part A as text
 *   POST /checkpoint/answer  { app, id, answers | changes, partA? }   records answers or a change request: { message }
 *   POST /checkpoint/approve { app, id, partA? }                       approves Part A: { message }
 *
 * `id` is the checkpoint the person was shown; a reply to one the build has
 * moved past is refused (409) rather than recorded against the wrong one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runA2App, type CliResult } from "./cli.js";
import { listApps } from "./connect.js";
import { failureOf, type ApiReply } from "./packages.js";

/** The open checkpoint as a row of `agent-app list --json` carries it. */
export interface CheckpointSummary {
  id: string;
  kind: "questions" | "review";
  round: number;
  status: "pending" | "answered" | "approved" | "changes" | "cancelled";
  shown: "ui" | "chat";
  createdAt: string;
}

const KINDS = new Set(["questions", "review"]);
const STATUSES = new Set(["pending", "answered", "approved", "changes", "cancelled"]);

/** A row's `checkpoint`, or null when it has none (or an unreadable one). */
export function parseCheckpoint(raw: unknown): CheckpointSummary | null {
  const c = raw as Record<string, unknown> | null;
  if (c === null || typeof c !== "object" || typeof c.id !== "string" || !KINDS.has(c.kind as string) || !STATUSES.has(c.status as string)) {
    return null;
  }
  return {
    id: c.id,
    kind: c.kind as CheckpointSummary["kind"],
    round: typeof c.round === "number" ? c.round : 1,
    status: c.status as CheckpointSummary["status"],
    shown: c.shown === "ui" ? "ui" : "chat",
    createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
  };
}

/** Whether a manager shows this checkpoint in the app's tab: it is waiting, and the build put it in the panel. */
export function checkpointWaiting(c: CheckpointSummary | null | undefined): c is CheckpointSummary {
  return c !== null && c !== undefined && c.status === "pending" && c.shown === "ui";
}

/** What the kickoff prompt of a manager-started build adds: where the person answers. */
export const BUILD_PANEL_NOTE =
  "This harness's build panel shows the build's checkpoints: scaffold with `--checkpoints ui`. The person answers your " +
  "questions and approves the requirements there, and their reply comes back to you as their next message.";

/** The checkpoint routes of a manager tab. Each method takes what the route received and returns the reply to send. */
export class CheckpointApi {
  /** @param by where an approval was given, as the spec's `### Approval` line names it: the harness's name. */
  constructor(
    private readonly frameworkBin: string,
    private readonly by: string,
  ) {}

  async show(app: unknown): Promise<ApiReply> {
    const path = await this.local(app);
    if (path === null) return notAnApp();
    const r = await runA2App(this.frameworkBin, [path, "checkpoint", "show"]);
    if (!r.ok) return failed(r);
    return { status: 200, body: { ...(r.json as Record<string, unknown>), ok: true } };
  }

  /** The person's answers to the questions (`answers`: `[{ id, choices, other? }]`), or a change request on Part A. */
  async answer(body: Record<string, unknown>): Promise<ApiReply> {
    return this.record(body, (path, partA) => {
      if (typeof body.changes === "string" && body.changes.trim() !== "") {
        return [path, "checkpoint", "answer", "--changes", body.changes.trim(), ...partA];
      }
      if (Array.isArray(body.answers)) return [path, "checkpoint", "answer", "--json", JSON.stringify({ answers: body.answers })];
      return null;
    });
  }

  async approve(body: Record<string, unknown>): Promise<ApiReply> {
    return this.record(body, (path, partA) => [path, "checkpoint", "approve", "--by", this.by, ...partA]);
  }

  private async record(body: Record<string, unknown>, argvFor: (path: string, partA: string[]) => string[] | null): Promise<ApiReply> {
    const path = await this.local(body.app);
    if (path === null) return notAnApp();
    const shown = await runA2App(this.frameworkBin, [path, "checkpoint", "show"]);
    const current = parseCheckpoint((shown.json as { checkpoint?: unknown } | null)?.checkpoint);
    if (current === null || current.id !== body.id || current.status !== "pending") {
      return { status: 409, body: { ok: false, reason: "moved", message: "The build has moved past this step. It will show what is waiting now." } };
    }
    // Part A travels as a file: it can be longer than a command line may be.
    const dir = typeof body.partA === "string" && body.partA.trim() !== "" ? mkdtempSync(join(tmpdir(), "a2app-part-a-")) : null;
    try {
      if (dir !== null) writeFileSync(join(dir, "part-a.md"), body.partA as string);
      const argv = argvFor(path, dir !== null ? ["--part-a", join(dir, "part-a.md")] : []);
      if (argv === null) return { status: 400, body: { ok: false, message: "Answer the questions, or say what to change." } };
      const r = await runA2App(this.frameworkBin, argv);
      if (!r.ok) return failed(r);
      const doc = r.json as Record<string, unknown>;
      return { status: 200, body: { ok: true, message: doc.message ?? null, checkpoint: doc.checkpoint ?? null } };
    } finally {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Only an app on this machine has a build to answer. */
  private async local(app: unknown): Promise<string | null> {
    if (typeof app !== "string" || app === "") return null;
    const { apps } = await listApps(this.frameworkBin);
    return apps.some((a) => a.path === app) ? app : null;
  }
}

function notAnApp(): ApiReply {
  return { status: 404, body: { ok: false, message: "not an app on this machine" } };
}

/** A refusal keeps the CLI's reason and what is wrong, so the panel can say which part of Part A to fix. */
function failed(r: CliResult): ApiReply {
  const doc = (r.json ?? {}) as { problems?: unknown; reason?: unknown };
  return {
    status: r.code === 2 ? 400 : r.code === 1 ? 422 : 500,
    body: {
      ok: false,
      message: failureOf(r),
      ...(Array.isArray(doc.problems) ? { problems: doc.problems } : {}),
      ...(typeof doc.reason === "string" ? { reason: doc.reason } : {}),
    },
  };
}
