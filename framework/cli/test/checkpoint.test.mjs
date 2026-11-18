/**
 * Build checkpoints (`agent-app <dir> checkpoint`): the builder's questions and
 * the review of Part A, shown in a harness's build panel or relayed in chat.
 *
 *  - scaffold records where checkpoints show (`--checkpoints ui`), in runtime
 *    state that is never committed;
 *  - questions are checked, one is open at a time, and there are at most two
 *    rounds — the builder decides the rest;
 *  - a panel records the answers and gets the text to post as the person's
 *    message; in chat, the builder records the reply;
 *  - a review opens only on a complete Part A; the person's edits replace Part
 *    A and never Part B; approval writes the dated line in `### Approval`;
 *  - `list --json` carries the open checkpoint on the app's row.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_APP = resolve(here, "..", "dist", "agent-app.js");
const TOOLKITS = resolve(here, "..", "..", "..", "toolkits");

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const base = mkdtempSync(join(tmpdir(), "a2app-checkpoint-"));
const home = join(base, "home");
mkdirSync(home);
const emptyConfig = join(base, "empty.gitconfig");
writeFileSync(emptyConfig, "");

function cli(args, env = {}) {
  return new Promise((done) => {
    const childEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", A2APP_HOME: home, A2APP_TOOLKITS_DIR: TOOLKITS, ...env };
    if (!("AGENT_APP_CHECKPOINTS" in env)) delete childEnv.AGENT_APP_CHECKPOINTS;
    const child = spawn(process.execPath, [AGENT_APP, ...args], { env: childEnv, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let result = null;
      try {
        result = JSON.parse(stdout.slice(stdout.indexOf("{")));
      } catch {
        /* no JSON result */
      }
      done({ code, out: stdout + stderr, result });
    });
  });
}

const spec = (app) => readFileSync(join(app, "reference", "requirements.md"), "utf8").replace(/\r\n/g, "\n");
const partB = (src) => src.slice(src.search(/^PART B\b/m));
const QUESTIONS = {
  intro: "Two things before I write the requirements:",
  questions: [
    { id: "who", question: "Who will use it?", options: ["Just me", "My team"] },
    { id: "features", question: "Which matter most?", why: "They shape the first screen.", options: ["Tags", "Search", "Export"], multiSelect: true },
    { id: "data", question: "Anything that must never be lost?" },
  ],
};

try {
  /* --------------------------------------------- scaffold records the mode */
  const app = join(base, "app");
  const made = await cli([app, "scaffold", "--blueprint", "blueprint-base", "--name", "Ledger", "--checkpoints", "ui"]);
  check("scaffold --checkpoints ui succeeds", made.code, 0);
  check("…and records the mode in runtime state", JSON.parse(readFileSync(join(app, ".a2app", "checkpoint.json"), "utf8")).mode, "ui");
  check("a bad --checkpoints value is a usage error", (await cli([join(base, "bad"), "scaffold", "--blueprint", "blueprint-base", "--checkpoints", "panel"])).code, 2);

  const shown = await cli([app, "checkpoint", "show"]);
  check("show with nothing opened", [shown.code, shown.result?.mode, shown.result?.checkpoint], [0, "ui", null]);
  check("checkpoint needs a subcommand", (await cli([app, "checkpoint"])).code, 2);
  check("…a known one", (await cli([app, "checkpoint", "interview"])).code, 2);
  check("--help works without one", (await cli([app, "checkpoint", "--help"])).code, 0);

  /* --------------------------------------------------------------- asking */
  check("no questions is a usage error", (await cli([app, "checkpoint", "ask", "--json", '{"questions":[]}'])).code, 2);
  check("eleven is too many", (await cli([app, "checkpoint", "ask", "--json", JSON.stringify({ questions: Array.from({ length: 11 }, (_, i) => ({ question: `Q${i}` })) })])).code, 2);
  check("a question needs text", (await cli([app, "checkpoint", "ask", "--json", '{"questions":[{"options":["a"]}]}'])).code, 2);
  check("ids are unique", (await cli([app, "checkpoint", "ask", "--json", '{"questions":[{"id":"a","question":"x"},{"id":"a","question":"y"}]}'])).code, 2);
  check("invalid JSON is a usage error", (await cli([app, "checkpoint", "ask", "--json", "{nope"])).code, 2);
  check("--file and --json are one or the other", (await cli([app, "checkpoint", "ask"])).code, 2);

  const questionsFile = join(base, "questions.json");
  writeFileSync(questionsFile, "﻿" + JSON.stringify(QUESTIONS));
  const asked = await cli([app, "checkpoint", "ask", "--file", questionsFile]);
  check("ask opens the questions", [asked.code, asked.result?.checkpoint?.kind, asked.result?.checkpoint?.status, asked.result?.checkpoint?.round], [0, "questions", "pending", 1]);
  check("…shown in the panel, so there is no chat message", [asked.result?.checkpoint?.shown, asked.result?.message], ["ui", undefined]);
  ok("…and the builder is told to end its turn", /End your turn now/.test(asked.result?.next ?? ""));
  check("…with ids defaulted where none was given", asked.result?.checkpoint?.questions?.map((q) => q.id), ["who", "features", "data"]);
  const qid = asked.result?.checkpoint?.id;

  const listed = await cli(["list", "--json"]);
  const row = listed.result?.apps?.find((a) => a.name === "Ledger");
  check("list --json carries the open checkpoint", [row?.checkpoint?.id, row?.checkpoint?.kind, row?.checkpoint?.status], [qid, "questions", "pending"]);
  ok("…without the questions themselves", row?.checkpoint && !("questions" in row.checkpoint));

  const twice = await cli([app, "checkpoint", "ask", "--json", '{"questions":[{"question":"again?"}]}']);
  check("one checkpoint is open at a time", [twice.code, twice.result?.reason], [1, "checkpoint_open"]);
  check("a questions checkpoint is not approved", (await cli([app, "checkpoint", "approve"])).result?.reason, "not_a_review");

  /* ------------------------------------------------------------ answering */
  check("an unknown question id is refused", (await cli([app, "checkpoint", "answer", "--json", '{"answers":[{"id":"nope","choices":[]}]}'])).code, 2);
  check("choices come from the options", (await cli([app, "checkpoint", "answer", "--json", '{"answers":[{"id":"who","choices":["Everyone"]}]}'])).code, 2);
  check("a single-choice question takes one", (await cli([app, "checkpoint", "answer", "--json", '{"answers":[{"id":"who","choices":["Just me","My team"]}]}'])).code, 2);
  check("a review's --changes does not answer questions", (await cli([app, "checkpoint", "answer", "--changes", "x"])).code, 2);

  const answered = await cli([app, "checkpoint", "answer", "--json", JSON.stringify({ answers: [{ id: "who", choices: ["Just me"] }, { id: "features", choices: ["Tags", "Search"], other: "CSV export" }] })]);
  check("the panel records the answers", [answered.code, answered.result?.checkpoint?.status], [0, "answered"]);
  const message = answered.result?.message ?? "";
  ok("…and gets the person's message, marked as recorded", message.startsWith(`My answers to your questions (checkpoint ${qid}, already recorded):`));
  ok("…with each answer under its question", /2\. Which matter most\?\n {3}→ Tags; Search; CSV export/.test(message));
  ok("…and a skipped question left to the builder", /3\. Anything that must never be lost\?\n {3}→ No answer — decide for me/.test(message));
  const again = await cli([app, "checkpoint", "answer", "--text", "me"]);
  check("answering again changes nothing", [again.code, again.result?.alreadyRecorded, again.result?.checkpoint?.answers?.length], [0, true, 3]);

  const second = await cli([app, "checkpoint", "ask", "--json", '{"questions":[{"question":"Dark mode?","options":["Yes","No"]}]}']);
  check("a follow-up is round 2", [second.code, second.result?.checkpoint?.round], [0, 2]);
  const replied = await cli([app, "checkpoint", "answer", "--text", "yes please"]);
  check("a chat reply is recorded as text", [replied.code, replied.result?.checkpoint?.text, replied.result?.message], [0, "yes please", undefined]);
  const third = await cli([app, "checkpoint", "ask", "--json", '{"questions":[{"question":"One more?"}]}']);
  check("a third round is refused", [third.code, third.result?.reason], [1, "round_limit"]);

  /* ---------------------------------------------------------------- review */
  const early = await cli([app, "checkpoint", "review"]);
  check("a review needs Part A written", [early.code, early.result?.reason], [1, "part_a_incomplete"]);
  ok("…and says what is missing", (early.result?.problems ?? []).some((p) => /placeholder/.test(p)));

  // Part A from the react-node starter (complete), Part B still the template's.
  const starter = readFileSync(join(TOOLKITS, "blueprint-react-node", "template", "reference", "requirements.md"), "utf8").replace(/\r\n/g, "\n");
  const original = spec(app);
  const starterPartA = starter.slice(0, starter.search(/^PART B\b/m)).trimEnd();
  writeFileSync(join(app, "reference", "requirements.md"), `${starterPartA}\n\n${partB(original)}`);
  const reviewed = await cli([app, "checkpoint", "review"]);
  check("a complete Part A opens the review", [reviewed.code, reviewed.result?.checkpoint?.kind, reviewed.result?.checkpoint?.round], [0, "review", 1]);
  const rid = reviewed.result?.checkpoint?.id;
  const showReview = await cli([app, "checkpoint", "show"]);
  ok("show gives the panel Part A to render", (showReview.result?.partA ?? "").includes("F-PLA-1") && !(showReview.result?.partA ?? "").includes("PART B"));
  check("…with nothing wrong in it", showReview.result?.problems, []);

  const editFile = join(base, "part-a.md");
  writeFileSync(editFile, starterPartA.replace("A personal to-do app", "A shared to-do app"));
  const changes = await cli([app, "checkpoint", "answer", "--changes", "Add due dates.", "--part-a", editFile]);
  check("a change request is recorded with the edit", [changes.code, changes.result?.checkpoint?.status, changes.result?.checkpoint?.edited], [0, "changes", true]);
  ok("…its message keeps the person's edits", /Add due dates\.\n\nI also edited Part A myself/.test(changes.result?.message ?? ""));
  ok("…Part A now holds the edit", spec(app).includes("A shared to-do app"));
  check("…and Part B is untouched", partB(spec(app)), partB(original));
  check("nothing is open to approve now", (await cli([app, "checkpoint", "approve"])).result?.reason, "nothing_open");

  check("round 2 of the review opens", (await cli([app, "checkpoint", "review"])).result?.checkpoint?.round, 2);
  const broken = join(base, "broken.md");
  writeFileSync(broken, starterPartA.replace(/## Out of Scope[\s\S]*?(?=\n## )/, "## Out of Scope\n"));
  const before = spec(app);
  const refused = await cli([app, "checkpoint", "approve", "--part-a", broken]);
  check("an incomplete edit is refused", [refused.code, refused.result?.reason], [1, "part_a_incomplete"]);
  check("…and nothing is written", spec(app), before);
  const withPartB = join(base, "with-part-b.md");
  writeFileSync(withPartB, `${starterPartA}\n\n${partB(original)}`);
  check("an edit carrying Part B is a usage error", (await cli([app, "checkpoint", "approve", "--part-a", withPartB])).code, 2);

  const approved = await cli([app, "checkpoint", "approve", "--by", "Test Harness"]);
  check("approve records the approval", [approved.code, approved.result?.checkpoint?.status, approved.result?.checkpoint?.by], [0, "approved", "Test Harness"]);
  const line = spec(app).split("\n")[spec(app).split("\n").findIndex((l) => /^### Approval/.test(l)) + 1];
  ok("…as the dated line in ### Approval, replacing the starter's", /^Approved by the user: \d{4}-\d{2}-\d{2}, in Test Harness \(checkpoint c-[0-9a-f]{8}\)$/.test(line ?? "") && !spec(app).includes("the starter ships as specified"));
  ok("…and tells the builder it was recorded", (approved.result?.message ?? "").includes("already recorded in ### Approval"));
  check("approving again changes nothing", (await cli([app, "checkpoint", "approve"])).result?.alreadyRecorded, true);
  ok("the review id was the one opened", typeof rid === "string" && rid !== approved.result?.checkpoint?.id);

  /* ----------------------------------------------------------------- chat */
  const chatApp = join(base, "chat");
  check("an app scaffolded without --checkpoints", (await cli([chatApp, "scaffold", "--blueprint", "blueprint-react-node", "--name", "Chatty"])).code, 0);
  ok("…has no checkpoint state", !existsSync(join(chatApp, ".a2app", "checkpoint.json")));
  const chatAsk = await cli([chatApp, "checkpoint", "ask", "--json", JSON.stringify(QUESTIONS)]);
  check("asks in chat", chatAsk.result?.checkpoint?.shown, "chat");
  ok("…with a message to send", /^Two things before I write the requirements:\n\n1\. \*\*Who will use it\?\*\*\n {3}One of: Just me · My team/.test(chatAsk.result?.message ?? ""));
  ok("…naming the multi-select ones", (chatAsk.result?.message ?? "").includes("Any of: Tags · Search · Export"));
  ok("…and how to record the reply", /checkpoint answer --text/.test(chatAsk.result?.next ?? ""));
  await cli([chatApp, "checkpoint", "answer", "--text", "1 just me, 2 tags"]);
  const chatReview = await cli([chatApp, "checkpoint", "review"]);
  ok("a chat review carries the summary", /\*\*Purpose:\*\* A personal to-do app[\s\S]*\*\*Features\*\*\n\*Module: planning\*\n- F-PLA-1/.test(chatReview.result?.message ?? ""));
  ok("…and how to approve", /checkpoint approve --by chat/.test(chatReview.result?.next ?? ""));
  await cli([chatApp, "checkpoint", "cancel"]);
  const panelled = await cli([chatApp, "checkpoint", "review"], { AGENT_APP_CHECKPOINTS: "ui" });
  check("AGENT_APP_CHECKPOINTS=ui puts it in the panel", panelled.result?.checkpoint?.shown, "ui");
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`checkpoint: ${failures.length} failure(s)\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("checkpoint: all checks passed");
