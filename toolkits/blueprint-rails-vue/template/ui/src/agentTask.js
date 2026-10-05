/**
 * Agent work, shown until it is done (AGENT-OWNED shared piece — @a2app-kit agent-task).
 *
 * An agent run takes seconds to minutes. Whatever control queued it has to
 * keep showing where it is, or the person is left with no sign anything is
 * happening. This module and the two components built on it are that display,
 * so a feature that queues work does not rebuild it:
 *
 *   <AgentTaskBadge :task-id="rec.agentTask" />             in a list row, beside the title
 *   <AgentTaskPanel :task-id="rec.agentTask"                under the row or on the record's screen
 *     @settled="reload" @retry="askAgain" />
 *
 * Both follow `GET /api/_a2app/tasks/{id}` at the task's own `pollAfterMs`,
 * only while it is unfinished, and share one poller per id, so a badge and a
 * panel for the same task cost one request. See AgentTaskPanel.vue for the
 * states it renders.
 *
 * A 404 means the task was pruned, so the indicator disappears. On a
 * multi-user app the read answers 401 — the View has no credential for the
 * queue. There, have the agent write its progress onto the record and pass it
 * as `:progress="{ status, step, summary, reason }"`; it renders the same way,
 * with or without a `task-id`.
 *
 * Never put `result.summary` in a title cell or a table column. It is prose of
 * any length and belongs in the panel.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { api } from "./api.js";
import "./agentTask.css";

export const FINISHED = new Set(["completed", "failed", "canceled"]);
/** How long a task may sit unclaimed before we say nobody is listening. */
export const NO_LISTENER_MS = 20_000;
const DEFAULT_POLL_MS = 2000;
const RETRY_MS = 5000;
/** Slower polling when nothing is likely to change soon: an unclaimed task, or a hidden tab. */
const SLOW_POLL_MS = 10_000;

export const LABEL = {
  submitted: "Waiting for an agent",
  unheard: "No agent is listening",
  working: "Agent working",
  "input-required": "Agent needs input",
  completed: "Agent done",
  failed: "Agent failed",
  canceled: "Agent run canceled",
};
export const TONE = {
  submitted: "neutral",
  unheard: "warning",
  working: "info",
  "input-required": "warning",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
};

/**
 * Reasons the queue and the bridge write themselves, in words. An agent's own
 * reason is prose already; these are codes, and a code is not an explanation.
 */
const REASON_WORDS = {
  redelivery_exhausted:
    "It was handed to an agent several times and never finished. Check that the bridge can start your agent, then ask again.",
  harness_unavailable: "The bridge could not find an agent to run on this machine.",
  harness_spawn_failed: "The bridge could not start the agent.",
  harness_exited_nonzero: "The agent stopped with an error before reporting back.",
  harness_timeout: "The agent took too long and was stopped.",
  unspecified: "The agent did not say why.",
};

/** A failure reason a person can read, plus the raw code when it was one. */
export function reasonInWords(reason, canceled = false) {
  if (!reason) return { text: canceled ? "The run was canceled." : "The agent did not say why.", code: null };
  if (REASON_WORDS[reason]) return { text: REASON_WORDS[reason], code: reason };
  // An unknown code (snake_case, no spaces) still gets a sentence around it.
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(reason)) return { text: "The run stopped before it finished.", code: reason };
  return { text: reason, code: null };
}

/* ------------------------------------------------------------- the poller */

// id -> { snap, listeners, timer, stopped }. `snap` is replaced, never mutated.
const watchers = new Map();
const IDLE = { phase: "idle", task: null };
const LOADING = { phase: "loading", task: null };

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

function publish(w, snap) {
  w.snap = snap;
  for (const l of w.listeners) l(snap);
}

async function poll(id, w) {
  if (w.stopped) return;
  let next = DEFAULT_POLL_MS;
  try {
    const task = await api(`/api/_a2app/tasks/${encodeURIComponent(id)}`);
    if (w.stopped) return;
    publish(w, { phase: "ok", task });
    if (FINISHED.has(task.status)) return; // settled: nothing more will change
    next = task.pollAfterMs ?? DEFAULT_POLL_MS;
    const waited = Date.now() - (ms(task.createdAt) ?? Date.now());
    if (task.status === "submitted" && waited > NO_LISTENER_MS) next = Math.max(next, SLOW_POLL_MS);
  } catch (err) {
    if (w.stopped) return;
    if (err?.status === 404) return publish(w, { phase: "gone", task: null });
    if (err?.status === 401 || err?.status === 403) return publish(w, { phase: "unauthorized", task: w.snap.task });
    // Network trouble or rate limiting: keep what we last knew and try again later.
    publish(w, { phase: "stale", task: w.snap.task, error: err?.message });
    next = err?.status === 429 ? SLOW_POLL_MS : RETRY_MS;
  }
  if (typeof document !== "undefined" && document.hidden) next = Math.max(next, SLOW_POLL_MS);
  w.timer = setTimeout(() => poll(id, w), next);
}

function subscribe(id, listener) {
  let w = watchers.get(id);
  if (!w) {
    w = { snap: LOADING, listeners: new Set(), timer: null, stopped: false };
    watchers.set(id, w);
    poll(id, w);
  }
  w.listeners.add(listener);
  listener(w.snap);
  return () => {
    w.listeners.delete(listener);
    // Stop only once nobody has re-subscribed by the next tick, so a row that
    // re-renders does not restart polling from scratch.
    setTimeout(() => {
      if (w.listeners.size > 0 || watchers.get(id) !== w) return;
      w.stopped = true;
      clearTimeout(w.timer);
      watchers.delete(id);
    }, 0);
  };
}

/**
 * Follow one queued task. `getId` is a getter (`() => props.taskId`). Returns
 * a ref of `{ phase, task }`: phase is loading · ok · stale (last known, the
 * read is failing) · gone (404) · unauthorized (401) · idle (no id).
 */
export function useAgentTask(getId) {
  const state = shallowRef(IDLE);
  let stop = () => {};
  const follow = (id) => {
    stop();
    if (!id) {
      state.value = IDLE;
      stop = () => {};
      return;
    }
    stop = subscribe(id, (snap) => (state.value = snap));
  };
  onMounted(() => follow(getId()));
  watch(getId, follow);
  onBeforeUnmount(() => stop());
  return state;
}

/** A clock that ticks each second while `isRunning()` is true. */
export function useNow(isRunning) {
  const now = ref(Date.now());
  let timer = null;
  const sync = (running) => {
    clearInterval(timer);
    timer = running ? setInterval(() => (now.value = Date.now()), 1000) : null;
  };
  watch(isRunning, sync, { immediate: true });
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}

/* ---------------------------------------------------------- shared logic */

/** "8s" · "1m 05s" · "1h 02m". */
export function fmtElapsed(span) {
  const s = Math.max(0, Math.floor(span / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * What a harness printed, when the agent closed no task itself: the bridge then
 * completes it with the run's output instead of a summary. Terminal colour
 * codes are noise in a page.
 */
function printedOutput(result) {
  if (typeof result?.output !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = result.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  return text || null;
}

/**
 * One view of a task, whichever way it arrived: the queue's own record, or the
 * progress an agent wrote onto the app's record.
 */
export function viewOf(state, progress, now) {
  const task = state.task;
  if (task) {
    const created = ms(task.createdAt);
    const claimed = ms(task.claim?.claimedAt);
    const updated = ms(task.updatedAt);
    let key = task.status;
    let elapsed = null;
    if (key === "submitted") {
      elapsed = created !== null ? now - created : null;
      if (elapsed !== null && elapsed >= NO_LISTENER_MS) key = "unheard";
    } else if (key === "working" || key === "input-required") {
      const since = claimed ?? created;
      elapsed = since !== null ? now - since : null;
    } else if (created !== null && updated !== null) {
      elapsed = updated - created;
    }
    return {
      key,
      elapsed,
      step: task.progress?.step ?? null,
      // The queue reports 0 until the agent says otherwise; only real progress draws a bar.
      percent: task.progress?.percent > 0 ? task.progress.percent : null,
      summary: task.result?.summary ?? null,
      output: printedOutput(task.result),
      reason: task.reason ?? null,
    };
  }
  if (progress?.status) {
    return {
      key: progress.status,
      elapsed: null,
      step: progress.step ?? null,
      percent: progress.percent > 0 ? progress.percent : null,
      summary: progress.summary ?? null,
      output: null,
      reason: progress.reason ?? null,
    };
  }
  return null;
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Plain text split into text and link parts, for rendering with its line
 * breaks kept and its links clickable. Sentence punctuation after a link is
 * not part of it.
 */
export function splitLinks(text) {
  return text.split(URL_RE).flatMap((part, i) => {
    if (i % 2 === 0) return part ? [{ text: part }] : [];
    const m = part.match(/^(.*?)([.,;:!?)\]]*)$/);
    const href = m ? m[1] : part;
    const tail = m ? m[2] : "";
    return tail ? [{ href }, { text: tail }] : [{ href }];
  });
}
