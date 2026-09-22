/**
 * The View (AGENT-OWNED — edit freely to change the human UI).
 *
 * A React SPA over the same records API the agent uses. Screens compose the
 * shared pieces (Icon, toast, ConfirmDialog) and the tokens in
 * public/tokens.css; every region renders all of its states (loading, empty,
 * error, list), every action acknowledges immediately, and every success is
 * read back from what the server STORED — never assumed from what was sent.
 *
 * This stack ships no update watcher (PocketBase serves static files with no
 * system-owned watcher route), so external changes show on the next read —
 * a reload, a filter switch, or your own re-read affordance.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { useToast } from "./toast.jsx";
import { useConfirm } from "./ConfirmDialog.jsx";
import { STATUS_LABEL, NEXT_STATUS, fmtDay, isPastDay } from "./format.js";

const API = "/api/collections/tasks/records";
const PER_PAGE = 100; // the client never renders an unbounded collection
const FILTERS = ["all", "todo", "doing", "done"];

const EMPTY_COPY = {
  all: ["No tasks yet", "Everything you add lands here — and your agent can add, update, and complete tasks for you."],
  todo: ["Nothing to do", "No tasks are waiting. Add one, or switch the filter to see the rest."],
  doing: ["Nothing in progress", "No tasks are marked as doing right now."],
  done: ["Nothing done yet", "Tasks you complete will collect here."],
};

export default function App() {
  const toast = useToast();
  const [confirm, confirmElement] = useConfirm();

  const [appName, setAppName] = useState("Tasks");
  const [items, setItems] = useState([]);
  const [totalItems, setTotalItems] = useState(0);
  const [filter, setFilter] = useState("all");
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(() => new Set()); // record ids with a write in flight
  const [adding, setAdding] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("todo");
  const [titleError, setTitleError] = useState(null);

  const titleRef = useRef(null);
  const loadSeq = useRef(0); // drops stale responses when filters change quickly
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  /* ---------------------------------------------------------------- load */

  const loadTasks = useCallback(
    async ({ append = false, filter: forFilter } = {}) => {
      const active = forFilter ?? filterRef.current;
      const seq = ++loadSeq.current;
      if (!append && itemsRef.current.length === 0) setPhase("loading");
      const page = append ? Math.floor(itemsRef.current.length / PER_PAGE) + 1 : 1;
      const params = new URLSearchParams({ sort: "-created", page: String(page), perPage: String(PER_PAGE) });
      if (active !== "all") params.set("filter", `status = "${active}"`);

      try {
        const res = await api(`${API}?${params}`);
        if (seq !== loadSeq.current) return; // a newer load superseded this one
        setItems((prev) => (append ? [...prev, ...(res.items ?? [])] : (res.items ?? [])));
        setTotalItems(res.totalItems ?? (res.items ?? []).length);
        setPhase("ready");
      } catch (err) {
        if (seq !== loadSeq.current) return;
        if (itemsRef.current.length > 0) {
          // Keep what the user already has; report the failure without blanking.
          toast("error", `Could not refresh the list. ${err.message}`);
          setPhase("ready");
        } else {
          setErrorMessage(err.message);
          setPhase("error");
        }
      }
    },
    [toast],
  );

  /* ---------------------------------------------------------------- boot */

  useEffect(() => {
    // Identity is fetched once per session — the header does not refetch what it has.
    api("/api/_a2app")
      .then((id) => {
        const name = id?.app?.name ?? "Tasks";
        setAppName(name);
        document.title = name;
      })
      .catch(() => {
        /* the list's own error state reports reachability; the header keeps its default */
      });
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
        e.preventDefault();
        titleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* -------------------------------------------------------------- actions */

  const markBusy = (id, on) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const changeFilter = (next) => {
    if (next === filterRef.current) return;
    setFilter(next);
    setItems([]);
    itemsRef.current = []; // loadTasks reads this synchronously for paging
    loadTasks({ filter: next });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("Give the task a title first.");
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setAdding(true);
    try {
      const stored = await api(API, { method: "POST", body: JSON.stringify({ title: trimmed, status }) });
      // Trust the stored record, not the sent one.
      if (filterRef.current === "all" || stored.status === filterRef.current) {
        setItems((prev) => [stored, ...prev]);
      }
      setTotalItems((n) => n + 1);
      setPhase("ready");
      toast("success", `Added "${stored.title}".`);
      setTitle("");
      titleRef.current?.focus();
    } catch (err) {
      toast("error", `Could not add the task. ${err.message}`);
    } finally {
      setAdding(false);
    }
  };

  const advanceStatus = async (task) => {
    const next = NEXT_STATUS[task.status ?? "todo"];
    markBusy(task.id, true);
    try {
      const stored = await api(`${API}/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      if (filterRef.current !== "all" && stored.status !== filterRef.current) {
        // The record left this view; the count follows it.
        setItems((prev) => prev.filter((t) => t.id !== task.id));
        setTotalItems((n) => n - 1);
      } else {
        setItems((prev) => prev.map((t) => (t.id === task.id ? stored : t)));
      }
    } catch (err) {
      toast("error", `Could not update "${task.title}". ${err.message}`);
    } finally {
      markBusy(task.id, false);
    }
  };

  const deleteTask = async (task) => {
    const confirmed = await confirm({
      title: "Delete this task?",
      body: `"${task.title}" will be removed permanently.`,
      confirmLabel: "Delete task",
      danger: true,
    });
    if (!confirmed) return;

    markBusy(task.id, true);
    try {
      await api(`${API}/${task.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((t) => t.id !== task.id));
      setTotalItems((n) => n - 1);
      toast("success", `Deleted "${task.title}".`);
    } catch (err) {
      toast("error", `Could not delete "${task.title}". ${err.message}`);
    } finally {
      markBusy(task.id, false);
    }
  };

  const showMore = async () => {
    setLoadingMore(true);
    try {
      await loadTasks({ append: true });
    } finally {
      setLoadingMore(false);
    }
  };

  /* --------------------------------------------------------------- render */

  const count =
    phase !== "ready"
      ? ""
      : filter === "all"
        ? `${totalItems} ${totalItems === 1 ? "task" : "tasks"}`
        : `${totalItems} ${STATUS_LABEL[filter].toLowerCase()} ${totalItems === 1 ? "task" : "tasks"}`;

  return (
    <div className="app">
      <header className="app-header">
        <h1>{appName}</h1>
        <p className="subtitle">Your list, shared with your agent — changes on either side show up on both.</p>
      </header>

      <main>
        <section className="card" aria-label="Add a task">
          <form className="add-form" noValidate onSubmit={onSubmit}>
            <div className="field">
              <label className="sr-only" htmlFor="new-title">
                Task title
              </label>
              <input
                id="new-title"
                ref={titleRef}
                className="input"
                type="text"
                maxLength={200}
                autoComplete="off"
                placeholder="What needs doing?"
                aria-describedby="title-error"
                aria-invalid={titleError ? "true" : "false"}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  // Clear the inline error as soon as the user starts fixing it.
                  setTitleError(null);
                }}
              />
              <p id="title-error" className="field-error" hidden={!titleError}>
                {titleError}
              </p>
            </div>
            <div className="field">
              <label className="sr-only" htmlFor="new-status">
                Initial status
              </label>
              <select id="new-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="todo">To do</option>
                <option value="doing">Doing</option>
                <option value="done">Done</option>
              </select>
            </div>
            <button className={`btn btn-primary${adding ? " pending" : ""}`} type="submit" disabled={adding}>
              Add task
            </button>
          </form>
        </section>

        <div className="toolbar">
          <div className="seg" role="group" aria-label="Filter tasks by status">
            {FILTERS.map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => changeFilter(f)}>
                {f === "all" ? "All" : STATUS_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        {phase === "error" && (
          <div className="banner" role="alert">
            <Icon name="alert" />
            <span className="msg">Could not load your tasks. {errorMessage}</span>
            <button className="btn btn-ghost" type="button" onClick={() => loadTasks()}>
              <Icon name="refresh" />
              Try again
            </button>
          </div>
        )}

        <section className="card" aria-label="Tasks">
          {phase === "loading" && <Skeleton />}
          {phase === "ready" && items.length === 0 && (
            <EmptyState filter={filter} onAddFirst={() => titleRef.current?.focus()} />
          )}
          {phase === "ready" && items.length > 0 && (
            <>
              <ul className="task-list">
                {items.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    busy={busy.has(task.id)}
                    onAdvance={() => advanceStatus(task)}
                    onDelete={() => deleteTask(task)}
                  />
                ))}
              </ul>
              {items.length < totalItems && (
                <div className="load-more">
                  <button
                    className={`btn btn-ghost${loadingMore ? " pending" : ""}`}
                    type="button"
                    disabled={loadingMore}
                    onClick={showMore}
                  >
                    Show more ({totalItems - items.length} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <footer className="app-footer">
        <span aria-live="polite">{count}</span>
        <span className="hint">Press / to add a task</span>
      </footer>

      {confirmElement}
    </div>
  );
}

/* ------------------------------------------------------------ components */

function TaskRow({ task, busy, onAdvance, onDelete }) {
  const st = task.status ?? "todo";
  const overdue = task.due && isPastDay(task.due) && st !== "done";
  return (
    <li className={`task${st === "done" ? " done" : ""}${busy ? " busy" : ""}`}>
      {/* status: a labelled 3-state control; colour is never the only channel */}
      <button
        className={`status-btn status-${st}`}
        type="button"
        title={`Mark as ${STATUS_LABEL[NEXT_STATUS[st]].toLowerCase()}`}
        aria-label={`Status: ${STATUS_LABEL[st]}. Mark as ${STATUS_LABEL[NEXT_STATUS[st]].toLowerCase()}.`}
        onClick={onAdvance}
      >
        {STATUS_LABEL[st]}
      </button>
      <span className="title" title={task.title}>
        {task.title}
      </span>
      {task.due && (
        <span className={`due${overdue ? " overdue" : ""}`}>
          {overdue ? `Overdue · ${fmtDay(task.due)}` : `Due ${fmtDay(task.due)}`}
        </span>
      )}
      <button className="btn-icon danger" type="button" aria-label={`Delete task "${task.title}"`} onClick={onDelete}>
        <Icon name="trash" />
      </button>
    </li>
  );
}

function EmptyState({ filter, onAddFirst }) {
  const [heading, body] = EMPTY_COPY[filter];
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="inbox" size={32} />
      </span>
      <h2>{heading}</h2>
      <p>{body}</p>
      {filter === "all" && (
        <button className="btn btn-primary" type="button" onClick={onAddFirst}>
          <Icon name="plus" />
          Add your first task
        </button>
      )}
    </div>
  );
}

/** First-paint placeholder. Row heights match the real rows so arriving
 *  content does not shift the layout. */
function Skeleton() {
  const rows = [1, 0.7, 0.85];
  return (
    <div>
      {rows.map((flex, i) => (
        <div className="skel-row" key={i}>
          <span className="skel" style={{ width: 24, height: 24, borderRadius: 9999 }} />
          <span className="skel" style={{ flex, height: 14 }} />
          <span className="skel" style={{ width: 56, height: 24, borderRadius: 9999 }} />
        </div>
      ))}
    </div>
  );
}
