/**
 * Agent work, shown until it is done (AGENT-OWNED shared piece — @a2app-kit agent-task).
 *
 * An agent run takes seconds to minutes. Whatever control queued it has to
 * keep showing where it is, or the person is left with no sign anything is
 * happening. This is that display, so a feature that queues work does not
 * rebuild it:
 *
 *   <AgentTaskBadge taskId={rec.agentTask} />            in a list row, beside the title
 *   <AgentTaskPanel taskId={rec.agentTask}               under the row or on the record's screen
 *     onSettled={reload} onRetry={askAgain} />
 *
 * Both follow `GET /api/_a2app/tasks/{id}` at the task's own `pollAfterMs`,
 * only while it is unfinished, and share one poller per id, so a badge and a
 * panel for the same task cost one request. Every state renders:
 *
 *   submitted        waiting, with elapsed time; after ~20 s unclaimed, says no
 *                    agent is listening and how to start one
 *   working          `progress.step` (and `percent` as a bar) and running time
 *   input-required   the agent is waiting on someone
 *   completed        `result.summary` in its own full-width block: line breaks
 *                    kept, links clickable, long text clamped behind "Show more".
 *                    No summary (the agent never closed the task itself, so the
 *                    bridge did)? The run's printed output, labelled as such.
 *   failed/canceled  the `reason` in words (the queue's and bridge's own codes
 *                    are translated), and "Ask again" when `onRetry` is given
 *
 * A 404 means the task was pruned, so the indicator disappears. On a
 * multi-user app the read answers 401 — the View has no credential for the
 * queue. There, have the agent write its progress onto the record and pass it
 * as `progress={{ status, step, summary, reason }}`; it renders the same way,
 * with or without a `taskId`.
 *
 * Never put `result.summary` in a title cell or a table column. It is prose of
 * any length and belongs in the panel.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";

const FINISHED = new Set(["completed", "failed", "canceled"]);
/** How long a task may sit unclaimed before we say nobody is listening. */
export const NO_LISTENER_MS = 20_000;
const DEFAULT_POLL_MS = 2000;
const RETRY_MS = 5000;
/** Slower polling when nothing is likely to change soon: an unclaimed task, or a hidden tab. */
const SLOW_POLL_MS = 10_000;
const CLAMP_CHARS = 280;
const CLAMP_LINES = 4;

const LABEL = {
  submitted: "Waiting for an agent",
  unheard: "No agent is listening",
  working: "Agent working",
  "input-required": "Agent needs input",
  completed: "Agent done",
  failed: "Agent failed",
  canceled: "Agent run canceled",
};
const TONE = {
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

// id -> { snap, listeners, timer, stopped }. `snap` is replaced, never
// mutated, so useSyncExternalStore sees each change.
const watchers = new Map();
const IDLE = { phase: "idle", task: null };
const LOADING = { phase: "loading", task: null };

function watcherFor(id) {
  let w = watchers.get(id);
  if (!w) {
    w = { snap: LOADING, listeners: new Set(), timer: null, stopped: false };
    watchers.set(id, w);
    poll(id, w);
  }
  return w;
}

function publish(w, snap) {
  w.snap = snap;
  for (const l of w.listeners) l();
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
  if (!id) return () => {};
  const w = watcherFor(id);
  w.listeners.add(listener);
  return () => {
    w.listeners.delete(listener);
    // Stop only once nobody has re-subscribed by the next tick: a re-render
    // (or a row moving between lists) unsubscribes and subscribes again at
    // once, and tearing down in between would restart polling from scratch.
    setTimeout(() => {
      if (w.listeners.size > 0 || watchers.get(id) !== w) return;
      w.stopped = true;
      clearTimeout(w.timer);
      watchers.delete(id);
    }, 0);
  };
}

/**
 * Follow one queued task. Returns `{ phase, task }`: phase is loading · ok ·
 * stale (last known, the read is failing) · gone (404) · unauthorized (401) ·
 * idle (no id).
 */
export function useAgentTask(taskId) {
  const sub = useCallback((l) => subscribe(taskId, l), [taskId]);
  const snap = useCallback(() => (taskId ? (watchers.get(taskId)?.snap ?? LOADING) : IDLE), [taskId]);
  return useSyncExternalStore(sub, snap);
}

/* ---------------------------------------------------------- shared logic */

/** Seconds ticking while something is unfinished; frozen once it settles. */
function useNow(running) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

/** "8s" · "1m 05s" · "1h 02m". */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

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
function viewOf(state, progress, now) {
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

/** Calls `fn(task)` once when a task we watched while unfinished settles. */
function useSettled(task, fn) {
  const prev = useRef(task?.status);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const was = prev.current;
    prev.current = task?.status;
    if (task && FINISHED.has(task.status) && was !== undefined && !FINISHED.has(was)) fnRef.current?.(task);
  }, [task?.status, task]);
}

/* ------------------------------------------------------------- the badge */

/** A compact state pill for a list row, so someone can leave the screen and come back. */
export function AgentTaskBadge({ taskId, progress }) {
  const state = useAgentTask(taskId);
  const live = state.task && !FINISHED.has(state.task.status);
  const now = useNow(Boolean(live));
  if (state.phase === "gone") return null;
  const v = viewOf(state, progress, now);
  if (!v) return null;
  const label = LABEL[v.key] ?? v.key;
  return (
    <span className={`agent-badge tone-${TONE[v.key] ?? "neutral"}${live ? " live" : ""}`} title={label}>
      <span className="agent-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------- the panel */

/**
 * The full display: state, elapsed time, progress, and the result in a
 * readable block. Give it the whole width of its container — under a list
 * row, not inside one of its cells.
 */
export function AgentTaskPanel({
  taskId,
  progress,
  title = "Agent",
  onSettled,
  onRetry,
  retrying = false,
  bridgeHint = "agent-app <app-dir> bridge start",
}) {
  const state = useAgentTask(taskId);
  const live = state.task && !FINISHED.has(state.task.status);
  const now = useNow(Boolean(live));
  useSettled(state.task, onSettled);

  if (state.phase === "gone") return null;
  if (state.phase === "loading" && !progress?.status) {
    return (
      <div className="agent-task tone-neutral" aria-busy="true">
        <div className="agent-task-head">
          <span className="agent-dot" aria-hidden="true" />
          <span className="agent-task-state">Checking on the agent…</span>
        </div>
      </div>
    );
  }

  const v = viewOf(state, progress, now);
  if (!v) {
    if (state.phase === "unauthorized") {
      return (
        <div className="agent-task tone-neutral" role="status">
          <p className="agent-task-note">
            This app needs sign-in to read the agent queue, so progress shows here only once the agent records it.
          </p>
        </div>
      );
    }
    return null;
  }

  const tone = TONE[v.key] ?? "neutral";
  const label = LABEL[v.key] ?? v.key;
  const finished = FINISHED.has(v.key);
  const elapsedText =
    v.elapsed === null ? null : finished ? `took ${fmtElapsed(v.elapsed)}` : fmtElapsed(v.elapsed);

  return (
    <section className={`agent-task tone-${tone}${live ? " live" : ""}`} aria-label={`${title}: ${label}`}>
      <div className="agent-task-head">
        <span className="agent-dot" aria-hidden="true" />
        {/* The live region carries the state only; the ticking clock stays out of it. */}
        <span className="agent-task-state" role="status">
          {label}
          {v.step && !finished ? <span className="agent-task-step"> — {v.step}</span> : null}
        </span>
        {elapsedText && (
          <span className="agent-task-elapsed" aria-hidden={!finished}>
            {elapsedText}
          </span>
        )}
        {state.phase === "stale" && <span className="agent-task-elapsed">reconnecting…</span>}
      </div>

      {v.percent !== null && !finished && (
        <div className="agent-task-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.percent)}>
          <span style={{ width: `${Math.min(100, Math.max(0, v.percent))}%` }} />
        </div>
      )}

      {v.key === "unheard" && (
        <p className="agent-task-note">
          Nothing has picked this up. Work is only delivered while an agent is listening — start one with{" "}
          <code>{bridgeHint}</code>.
        </p>
      )}
      {v.key === "input-required" && (
        <p className="agent-task-note">The agent is waiting for someone to answer it before it can continue.</p>
      )}

      {v.key === "completed" && v.summary && <AgentResult text={v.summary} />}
      {v.key === "completed" && !v.summary && v.output && (
        <AgentResult text={v.output} note="The agent sent no summary. This is what it printed:" />
      )}

      {(v.key === "failed" || v.key === "canceled") && (
        <div className="agent-task-failure">
          <FailureReason reason={v.reason} canceled={v.key === "canceled"} />
          {onRetry && (
            <button className={`btn btn-ghost${retrying ? " pending" : ""}`} type="button" disabled={retrying} onClick={onRetry}>
              <Icon name="refresh" />
              Ask again
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function FailureReason({ reason, canceled }) {
  const { text, code } = reasonInWords(reason, canceled);
  return (
    <p className="agent-task-note">
      {text}
      {code && <span className="agent-task-code"> ({code})</span>}
    </p>
  );
}

/* ------------------------------------------------------------ the result */

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Plain text with its line breaks kept and its links clickable. */
function Linkified({ text }) {
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    // Sentence punctuation after a link is not part of it.
    const m = part.match(/^(.*?)([.,;:!?)\]]*)$/);
    const href = m ? m[1] : part;
    return (
      <span key={i}>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {href}
        </a>
        {m ? m[2] : ""}
      </span>
    );
  });
}

/** An agent's answer: its own block, readable at any length. */
export function AgentResult({ text, note }) {
  const long = text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES;
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-result">
      {note && <p className="agent-task-note">{note}</p>}
      <p className={`agent-result-text${long && !open ? " clamped" : ""}`}>
        <Linkified text={text} />
      </p>
      {long && (
        <button className="agent-result-toggle" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
