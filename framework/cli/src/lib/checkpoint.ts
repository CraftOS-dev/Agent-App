/**
 * Build checkpoints: the two moments a creation stops for the person — the
 * builder's clarifying questions, and the review of Part A before anything is
 * built.
 *
 * The state is one file, `.a2app/checkpoint.json`: runtime, so it is never
 * committed, exported or fingerprinted. It records how this build shows a
 * checkpoint (`mode`) — `ui` when a harness panel renders it, `chat` when the
 * agent relays it — the checkpoint now open, and the ones before it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./home.js";

export type CheckpointMode = "ui" | "chat";
export type CheckpointKind = "questions" | "review";
export type CheckpointStatus = "pending" | "answered" | "approved" | "changes" | "cancelled";

export interface Question {
  id: string;
  question: string;
  why?: string;
  options: string[];
  multiSelect: boolean;
}

export interface Answer {
  id: string;
  choices: string[];
  other?: string;
}

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  /** 1 for the first batch of questions, 2 for the follow-up; 1.. for reviews. */
  round: number;
  status: CheckpointStatus;
  shown: CheckpointMode;
  createdAt: string;
  intro?: string;
  questions?: Question[];
  answeredAt?: string;
  /** The person's answers from a panel's form. */
  answers?: Answer[];
  /** The person's reply in their own words (a chat reply, or a change request). */
  text?: string;
  /** Part A was edited by the person in the panel. */
  edited?: boolean;
  /** Where the approval was given. */
  by?: string;
}

export interface CheckpointState {
  version: 1;
  mode?: CheckpointMode;
  current: Checkpoint | null;
  history: Checkpoint[];
}

/** A row's view of the open checkpoint: enough for a panel to know there is
 *  something to show, without the questions or the spec. */
export interface CheckpointSummary {
  id: string;
  kind: CheckpointKind;
  round: number;
  status: CheckpointStatus;
  shown: CheckpointMode;
  createdAt: string;
}

export function checkpointFile(appDir: string): string {
  return join(appDir, ".a2app", "checkpoint.json");
}

export function readCheckpoints(appDir: string): CheckpointState {
  const file = checkpointFile(appDir);
  if (!existsSync(file)) return { version: 1, current: null, history: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<CheckpointState>;
    return {
      version: 1,
      ...(raw.mode === "ui" || raw.mode === "chat" ? { mode: raw.mode } : {}),
      current: raw.current ?? null,
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch {
    return { version: 1, current: null, history: [] };
  }
}

export function writeCheckpoints(appDir: string, state: CheckpointState): void {
  writeFileAtomic(checkpointFile(appDir), JSON.stringify(state, null, 2) + "\n");
}

/**
 * How this build shows a checkpoint. `AGENT_APP_CHECKPOINTS` wins, for a
 * harness that declares its panel per process; otherwise what scaffold
 * recorded; otherwise chat, which every harness has.
 */
export function checkpointMode(state: CheckpointState): CheckpointMode {
  const env = process.env.AGENT_APP_CHECKPOINTS?.trim();
  if (env === "ui" || env === "chat") return env;
  return state.mode ?? "chat";
}

export function checkpointSummary(appDir: string): CheckpointSummary | null {
  const current = readCheckpoints(appDir).current;
  if (current === null) return null;
  const { id, kind, round, status, shown, createdAt } = current;
  return { id, kind, round, status, shown, createdAt };
}
