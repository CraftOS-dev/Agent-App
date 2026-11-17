/**
 * agent-app <dir> checkpoint ask --file <questions.json> | --json '<questions>'
 * agent-app <dir> checkpoint review
 * agent-app <dir> checkpoint show
 * agent-app <dir> checkpoint answer --file <answers.json> | --json '<answers>' | --text "<reply>" | --changes "<request>" [--part-a <file>]
 * agent-app <dir> checkpoint approve [--part-a <file>] [--by <where>]
 * agent-app <dir> checkpoint cancel
 *
 * The two moments a creation stops for the person: the builder's clarifying
 * questions, and the review of Part A before anything is built. The builder
 * opens one (`ask`, `review`) and ends its turn; the person's reply comes back
 * as their next message.
 *
 * Where the person sees it is the harness's to decide, and it is decided once,
 * at scaffold (`--checkpoints ui`): a harness with a build panel renders the
 * checkpoint there and records the reply itself (`show`, then `answer` or
 * `approve`, which print the text to post as the person's message). Any other
 * harness gets the checkpoint as a chat message the builder sends, and the
 * builder records the reply. Either way the approval line in `### Approval` is
 * written here, never by hand.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseFlags } from "../lib/args.js";
import {
  checkpointMode,
  readCheckpoints,
  writeCheckpoints,
  type Answer,
  type Checkpoint,
  type CheckpointState,
  type Question,
} from "../lib/checkpoint.js";
import { partAProblems, partASummary, REQUIREMENTS_DOC, splitRequirements, withApproval } from "../lib/frameworkFiles.js";
import { writeFileAtomic } from "../lib/home.js";
import { withLock } from "../lib/lock.js";
import { log } from "../lib/log.js";
import { loadProject, UsageError } from "../lib/project.js";

/** One batch, and at most one follow-up: the builder decides the rest and
 *  records it as an assumption, so a build is never held in an interview. */
const MAX_QUESTION_ROUNDS = 2;
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 8;

const SUBCOMMANDS = ["ask", "review", "show", "answer", "approve", "cancel"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

class Refusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

export async function run(args: string[], app: string): Promise<number> {
  const sub = args[0] as Subcommand | undefined;
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
    throw new UsageError(`checkpoint needs one of: ${SUBCOMMANDS.join(", ")}${sub === undefined ? "" : ` (got "${sub}")`}`);
  }
  const rest = args.slice(1);
  const project = loadProject(app);
  const dir = project.dir;
  try {
    const result = await withLock(join(dir, ".a2app", "checkpoint.lock"), () => dispatch(sub, rest, dir, project.manifest.name ?? "the app"));
    log.raw(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    log.error(err.message);
    for (const problem of err.problems) log.info(`  - ${problem}`);
    log.raw(JSON.stringify({ ok: false, reason: err.reason, error: err.message, ...(err.problems.length > 0 ? { problems: err.problems } : {}) }, null, 2));
    return 1;
  }
}

function dispatch(sub: Subcommand, args: string[], dir: string, name: string): Record<string, unknown> {
  const state = readCheckpoints(dir);
  switch (sub) {
    case "ask":
      return ask(args, dir, state);
    case "review":
      return review(args, dir, state, name);
    case "show":
      noFlags("show", args);
      return show(dir, state);
    case "answer":
      return answer(args, dir, state);
    case "approve":
      return approve(args, dir, state);
    case "cancel": {
      noFlags("cancel", args);
      const current = open(state);
      close(dir, state, { ...current, status: "cancelled", answeredAt: now() });
      return { checkpoint: state.current, next: "Withdrawn. Open a new checkpoint when you need the person again." };
    }
  }
}

/* ------------------------------------------------------------------- open */

function ask(args: string[], dir: string, state: CheckpointState): Record<string, unknown> {
  const flags = parseFlags(args, { values: ["file", "json"] });
  noPositionals("ask", flags.positionals);
  const input = jsonInput(flags.values, "questions");
  const { intro, questions } = parseQuestions(input);
  guardNothingOpen(state);
  const round = rounds(state, "questions") + 1;
  if (round > MAX_QUESTION_ROUNDS) {
    throw new Refusal(
      "round_limit",
      `The questions are asked in one batch and at most one follow-up, and both were asked. Decide the rest yourself and record each decision under "### Assumptions" in Part A.`,
    );
  }
  const checkpoint: Checkpoint = {
    id: newId(),
    kind: "questions",
    round,
    status: "pending",
    shown: checkpointMode(state),
    createdAt: now(),
    ...(intro !== undefined ? { intro } : {}),
    questions,
  };
  openCheckpoint(dir, state, checkpoint);
  if (checkpoint.shown === "ui") {
    return {
      checkpoint,
      next:
        `End your turn now. The person answers these ${questions.length} question(s) in the harness's build panel — ` +
        "tell them in one short line that they are waiting there, and do not repeat them in chat. Their answers arrive " +
        "as their next message, already recorded.",
    };
  }
  return {
    checkpoint,
    message: questionsMessage(checkpoint),
    next:
      "Send `message` to the person as it is, then end your turn. When they reply, record the reply with " +
      '`agent-app <dir> checkpoint answer --text "<their reply>"` and continue.',
  };
}

function review(args: string[], dir: string, state: CheckpointState, name: string): Record<string, unknown> {
  noFlags("review", args);
  const src = readSpec(dir);
  const problems = partAProblems(src);
  if (problems.length > 0) {
    throw new Refusal("part_a_incomplete", `Part A of ${REQUIREMENTS_DOC} is not ready for the person to review.`, problems);
  }
  guardNothingOpen(state);
  const round = rounds(state, "review") + 1;
  const checkpoint: Checkpoint = { id: newId(), kind: "review", round, status: "pending", shown: checkpointMode(state), createdAt: now() };
  openCheckpoint(dir, state, checkpoint);
  if (checkpoint.shown === "ui") {
    return {
      checkpoint,
      next:
        "End your turn now. The person reads, edits and approves Part A in the harness's build panel — tell them in " +
        "one short line that the requirements are ready there. Their decision arrives as their next message, already " +
        `recorded: on approval, re-read ${REQUIREMENTS_DOC} (they may have edited it) and go on to Part B; on a change ` +
        "request, revise Part A and run `checkpoint review` again.",
    };
  }
  return {
    checkpoint,
    message:
      `The requirements for ${name} are ready for your review (checkpoint ${checkpoint.id}):\n\n${partASummary(src)}\n\n` +
      `The full text is in ${REQUIREMENTS_DOC}. Reply "approve" to build it as written, or tell me what to change.`,
    next:
      "Send `message` to the person as it is, then end your turn. When they reply: an explicit approval → " +
      "`agent-app <dir> checkpoint approve --by chat`, then go on to Part B; anything else → " +
      '`agent-app <dir> checkpoint answer --changes "<their reply>"`, revise Part A, and run `checkpoint review` again.',
  };
}

/* ------------------------------------------------------------------- read */

function show(dir: string, state: CheckpointState): Record<string, unknown> {
  const current = state.current;
  const out: Record<string, unknown> = { mode: checkpointMode(state), checkpoint: current };
  if (current?.kind === "review" && existsSync(join(dir, REQUIREMENTS_DOC))) {
    const src = readSpec(dir);
    out.requirements = REQUIREMENTS_DOC;
    out.partA = splitRequirements(src).partA.trimEnd() + "\n";
    out.problems = partAProblems(src);
  }
  return out;
}

/* ----------------------------------------------------------------- record */

function answer(args: string[], dir: string, state: CheckpointState): Record<string, unknown> {
  const flags = parseFlags(args, { values: ["file", "json", "text", "changes", "part-a"] });
  noPositionals("answer", flags.positionals);
  const current = state.current;
  if (current !== null && current.status !== "pending" && current.status !== "cancelled") {
    return { checkpoint: current, alreadyRecorded: true, next: "Already recorded. Continue from the person's reply." };
  }
  const pending = open(state);

  if (pending.kind === "questions") {
    if (flags.values.has("changes") || flags.values.has("part-a")) {
      throw new UsageError("--changes and --part-a answer a review; this checkpoint is questions");
    }
    const text = flags.values.get("text")?.trim();
    if (text !== undefined) {
      if (flags.values.has("file") || flags.values.has("json")) throw new UsageError("pass the reply as --text, or the answers as --file/--json — not both");
      if (text === "") throw new UsageError('--text needs the person\'s reply: --text "<reply>"');
      close(dir, state, { ...pending, status: "answered", answeredAt: now(), text });
      return { checkpoint: state.current, next: "Recorded. Continue with the person's answers." };
    }
    const answers = parseAnswers(jsonInput(flags.values, "answers"), pending.questions ?? []);
    close(dir, state, { ...pending, status: "answered", answeredAt: now(), answers });
    return { checkpoint: state.current, message: answersMessage(state.current!) };
  }

  // A review answered with anything but approval is a change request.
  const request = (flags.values.get("changes") ?? flags.values.get("text"))?.trim();
  if (flags.values.has("file") || flags.values.has("json")) throw new UsageError("a review is answered with --changes (or approved with `checkpoint approve`)");
  if (request === undefined || request === "") throw new UsageError('a review needs --changes "<what to change>"');
  const edited = applyPartA(dir, flags.values.get("part-a"));
  close(dir, state, { ...pending, status: "changes", answeredAt: now(), text: request, ...(edited ? { edited } : {}) });
  return {
    checkpoint: state.current,
    message:
      `Please revise the requirements (checkpoint ${pending.id}, already recorded):\n\n${request}` +
      (edited ? `\n\nI also edited Part A myself in ${REQUIREMENTS_DOC} — keep my edits.` : ""),
  };
}

function approve(args: string[], dir: string, state: CheckpointState): Record<string, unknown> {
  const flags = parseFlags(args, { values: ["part-a", "by"] });
  noPositionals("approve", flags.positionals);
  const current = state.current;
  if (current?.kind === "review" && current.status === "approved") {
    return { checkpoint: current, alreadyRecorded: true, next: "Already approved. Go on to Part B." };
  }
  const pending = open(state);
  if (pending.kind !== "review") throw new Refusal("not_a_review", `Checkpoint ${pending.id} is questions; only a review is approved.`);
  const by = flags.values.get("by")?.trim() || (pending.shown === "ui" ? "the build panel" : "chat");
  const edited = applyPartA(dir, flags.values.get("part-a"));
  const src = readSpec(dir);
  const problems = partAProblems(src);
  if (problems.length > 0) throw new Refusal("part_a_incomplete", "Part A cannot be approved as it stands.", problems);
  writeFileAtomic(join(dir, REQUIREMENTS_DOC), withApproval(src, `Approved by the user: ${today()}, in ${by} (checkpoint ${pending.id})`));
  close(dir, state, { ...pending, status: "approved", answeredAt: now(), by, ...(edited ? { edited } : {}) });
  return {
    checkpoint: state.current,
    message:
      `I approved the requirements (checkpoint ${pending.id}, already recorded in ### Approval).` +
      (edited ? ` I edited Part A before approving — re-read ${REQUIREMENTS_DOC} and build what it now says.` : ""),
    next: "Part A is approved and frozen; changes from here go through ## Changes. Go on to Part B.",
  };
}

/* ---------------------------------------------------------------- helpers */

function readSpec(dir: string): string {
  const file = join(dir, REQUIREMENTS_DOC);
  if (!existsSync(file)) throw new Refusal("no_spec", `${REQUIREMENTS_DOC} does not exist — the app was scaffolded without it.`);
  return readFileSync(file, "utf8");
}

/** Replace Part A with the person's edit, refusing an edit that would not
 *  pass the review's own check. Part B is never touched. */
function applyPartA(dir: string, file: string | undefined): boolean {
  if (file === undefined) return false;
  if (!existsSync(file)) throw new UsageError(`--part-a: no such file: ${file}`);
  const partA = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd();
  if (partA === "") throw new UsageError("--part-a is empty");
  if (/^PART B\b/m.test(partA)) throw new UsageError("--part-a holds Part B too; pass Part A only");
  const { partB } = splitRequirements(readSpec(dir));
  const next = `${partA}\n\n${partB}`.trimEnd() + "\n";
  const problems = partAProblems(next);
  if (problems.length > 0) throw new Refusal("part_a_incomplete", "The edited Part A is not complete.", problems);
  writeFileAtomic(join(dir, REQUIREMENTS_DOC), next);
  return true;
}

/** How many of this kind were put to the person — the current one included,
 *  withdrawn ones not. */
function rounds(state: CheckpointState, kind: Checkpoint["kind"]): number {
  return [...state.history, ...(state.current !== null ? [state.current] : [])].filter((c) => c.kind === kind && c.status !== "cancelled").length;
}

function guardNothingOpen(state: CheckpointState): void {
  if (state.current?.status === "pending") {
    throw new Refusal(
      "checkpoint_open",
      `Checkpoint ${state.current.id} (${state.current.kind}) is still waiting for the person. Wait for their reply, or withdraw it with \`checkpoint cancel\`.`,
    );
  }
}

function open(state: CheckpointState): Checkpoint {
  const current = state.current;
  if (current === null || current.status !== "pending") {
    throw new Refusal("nothing_open", current === null ? "No checkpoint has been opened for this app." : `Checkpoint ${current.id} is ${current.status}; nothing is waiting.`);
  }
  return current;
}

function openCheckpoint(dir: string, state: CheckpointState, checkpoint: Checkpoint): void {
  if (state.current !== null) state.history.push(state.current);
  state.current = checkpoint;
  writeCheckpoints(dir, state);
}

function close(dir: string, state: CheckpointState, checkpoint: Checkpoint): void {
  state.current = checkpoint;
  writeCheckpoints(dir, state);
}

function jsonInput(values: Map<string, string>, what: string): unknown {
  const file = values.get("file");
  const inline = values.get("json");
  if ((file === undefined) === (inline === undefined)) throw new UsageError(`pass the ${what} as --file <path> or --json '<json>'`);
  const text = file !== undefined ? (existsSync(file) ? readFileSync(file, "utf8") : null) : inline!;
  if (text === null) throw new UsageError(`--file: no such file: ${file}`);
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new UsageError(`the ${what} are not valid JSON: ${(err as Error).message}`);
  }
}

function parseQuestions(input: unknown): { intro?: string; questions: Question[] } {
  const body = Array.isArray(input) ? { questions: input } : (input as { intro?: unknown; questions?: unknown });
  if (body === null || typeof body !== "object" || !Array.isArray(body.questions)) {
    throw new UsageError('questions are {"questions": [{"question": "…", "options": ["…"], "multiSelect": false}]}');
  }
  if (body.questions.length === 0 || body.questions.length > MAX_QUESTIONS) {
    throw new UsageError(`ask 1 to ${MAX_QUESTIONS} questions (got ${body.questions.length}) — only what you genuinely cannot decide`);
  }
  const intro = body.intro === undefined ? undefined : text(body.intro, "intro", 600);
  const seen = new Set<string>();
  const questions = body.questions.map((raw: unknown, i: number): Question => {
    const q = (raw ?? {}) as Record<string, unknown>;
    const where = `question ${i + 1}`;
    const id = q.id === undefined ? `q${i + 1}` : text(q.id, `${where} id`, 40);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new UsageError(`${where}: id "${id}" may hold only letters, digits, - and _`);
    if (seen.has(id)) throw new UsageError(`${where}: id "${id}" is used twice`);
    seen.add(id);
    const options = q.options === undefined ? [] : q.options;
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) throw new UsageError(`${where}: options is a list of at most ${MAX_OPTIONS}`);
    const list = options.map((o, j) => text(o, `${where} option ${j + 1}`, 160));
    if (new Set(list).size !== list.length) throw new UsageError(`${where}: an option is listed twice`);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") throw new UsageError(`${where}: multiSelect is true or false`);
    return {
      id,
      question: text(q.question, `${where} text`, 500),
      ...(q.why !== undefined ? { why: text(q.why, `${where} why`, 300) } : {}),
      options: list,
      multiSelect: q.multiSelect === true,
    };
  });
  return { ...(intro !== undefined ? { intro } : {}), questions };
}

function parseAnswers(input: unknown, questions: Question[]): Answer[] {
  const body = Array.isArray(input) ? { answers: input } : (input as { answers?: unknown });
  if (body === null || typeof body !== "object" || !Array.isArray(body.answers)) {
    throw new UsageError('answers are {"answers": [{"id": "…", "choices": ["…"], "other": "…"}]}');
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out = new Map<string, Answer>();
  for (const raw of body.answers as unknown[]) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const id = typeof a.id === "string" ? a.id : "";
    const question = byId.get(id);
    if (question === undefined) throw new UsageError(`no question has the id "${id}"`);
    if (out.has(id)) throw new UsageError(`question "${id}" is answered twice`);
    const choices = a.choices === undefined ? [] : a.choices;
    if (!Array.isArray(choices) || choices.some((c) => typeof c !== "string" || !question.options.includes(c))) {
      throw new UsageError(`question "${id}": choices must be among its options`);
    }
    if (!question.multiSelect && choices.length > 1) throw new UsageError(`question "${id}" takes one choice`);
    const other = typeof a.other === "string" && a.other.trim() !== "" ? a.other.trim().slice(0, 2000) : undefined;
    out.set(id, { id, choices: [...new Set(choices as string[])], ...(other !== undefined ? { other } : {}) });
  }
  return questions.map((q) => out.get(q.id) ?? { id: q.id, choices: [] });
}

function questionsMessage(checkpoint: Checkpoint): string {
  const lines = [checkpoint.intro ?? "Before I write the requirements, a few questions:", ""];
  (checkpoint.questions ?? []).forEach((q, i) => {
    lines.push(`${i + 1}. **${q.question}**`);
    if (q.why !== undefined) lines.push(`   _${q.why}_`);
    if (q.options.length > 0) lines.push(`   ${q.multiSelect ? "Any of" : "One of"}: ${q.options.join(" · ")}`);
  });
  lines.push("", "Answer in your own words; numbers are fine (for example: 1 — the first option, 2 — …). Anything you skip, I decide.");
  return lines.join("\n");
}

function answersMessage(checkpoint: Checkpoint): string {
  const answers = new Map((checkpoint.answers ?? []).map((a) => [a.id, a]));
  const lines = [`My answers to your questions (checkpoint ${checkpoint.id}, already recorded):`, ""];
  (checkpoint.questions ?? []).forEach((q, i) => {
    const a = answers.get(q.id);
    const parts = [...(a?.choices ?? []), ...(a?.other !== undefined ? [a.other] : [])];
    lines.push(`${i + 1}. ${q.question}`, `   → ${parts.length > 0 ? parts.join("; ") : "No answer — decide for me"}`);
  });
  return lines.join("\n");
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(`${what} must be non-empty text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UsageError(`${what} is longer than ${max} characters`);
  return trimmed;
}

function noFlags(sub: string, args: string[]): void {
  if (args.length > 0) throw new UsageError(`checkpoint ${sub} takes no arguments (got ${args.join(" ")})`);
}

function noPositionals(sub: string, positionals: string[]): void {
  if (positionals.length > 0) throw new UsageError(`checkpoint ${sub}: unexpected ${positionals.join(" ")}`);
}

function newId(): string {
  return `c-${randomBytes(4).toString("hex")}`;
}

function now(): string {
  return new Date().toISOString();
}

/** The local calendar date — the day the person approved, where they are. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
