/**
 * The View (AGENT-OWNED — edit freely to change the human UI).
 *
 * A dependency-free SPA over the same records API the agent uses. Same-origin
 * writes are trusted by the adapter's origin rule, so the browser needs no
 * token. A human edits here; an agent operates the same data through A2App —
 * both see each other's changes on the next read.
 *
 * Screens compose the widgets in ui.js and the tokens in tokens.css; every
 * region renders all of its states (loading, empty, error, list), every action
 * acknowledges immediately, and every success is read back from what the
 * server STORED — never assumed from what was sent.
 */
import { el, icon, toast, confirmDialog, fmtDay, isPastDay } from "./ui.js";
// The update watcher (system-owned, loaded by index.html) reports two different
// kinds of staleness. A CODE change it handles itself, by reloading when the
// page holds nothing unsaved. A DATA change it only announces — because only
// this file knows how to re-read without discarding a form someone is filling
// in. Borrow its check so both paths apply the same rule.
import { hasUnsavedInput } from "/_a2app/update.js";

const API = "/api/collections/tasks/records";
const PER_PAGE = 100; // the client never renders an unbounded collection
const STATUS_LABEL = { todo: "To do", doing: "Doing", done: "Done" };
const NEXT_STATUS = { todo: "doing", doing: "done", done: "todo" };

const dom = {
  appName: document.getElementById("app-name"),
  form: document.getElementById("add-form"),
  title: document.getElementById("new-title"),
  titleError: document.getElementById("title-error"),
  status: document.getElementById("new-status"),
  addBtn: document.getElementById("add-btn"),
  filter: document.getElementById("filter"),
  bannerSlot: document.getElementById("banner-slot"),
  listSlot: document.getElementById("list-slot"),
  count: document.getElementById("count"),
};

const state = {
  items: [],        // records of the current view, server order (-created)
  totalItems: 0,    // total matching the current filter, from the server
  filter: "all",
  phase: "loading", // loading | ready | error
  loadSeq: 0,       // drops stale responses when filters change quickly
  busy: new Set(),  // record ids with a write in flight
};

/* ------------------------------------------------------------------- api */

/**
 * One fetch wrapper for the whole View: 10 s timeout on every call, JSON in
 * and out, and errors surfaced as messages a screen can show. Idempotent GETs
 * retry once on network failure with a short jittered delay; writes never
 * retry (the UI disables the control instead, so a retry is the user's call).
 */
async function api(path, init = {}, { retryGet = true } = {}) {
  const isGet = !init.method || init.method === "GET";
  try {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      ...init,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message = json?.message ?? `The app answered with an error (HTTP ${res.status}).`;
      throw Object.assign(new Error(message), { status: res.status });
    }
    return json;
  } catch (err) {
    if (isGet && retryGet && !(err && "status" in err)) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
      return api(path, init, { retryGet: false });
    }
    if (err?.name === "TimeoutError") throw new Error("The app took too long to answer.");
    if (err instanceof TypeError) throw new Error("The app is not reachable right now.");
    throw err;
  }
}

/* ------------------------------------------------------------------ load */

async function loadTasks({ append = false } = {}) {
  const seq = ++state.loadSeq;
  if (!append && state.items.length === 0) {
    state.phase = "loading";
    render();
  }
  const page = append ? Math.floor(state.items.length / PER_PAGE) + 1 : 1;
  const params = new URLSearchParams({ sort: "-created", page: String(page), perPage: String(PER_PAGE) });
  if (state.filter !== "all") params.set("filter", `status = "${state.filter}"`);

  try {
    const res = await api(`${API}?${params}`);
    if (seq !== state.loadSeq) return; // a newer load superseded this one
    state.items = append ? [...state.items, ...(res.items ?? [])] : (res.items ?? []);
    state.totalItems = res.totalItems ?? state.items.length;
    state.phase = "ready";
    render();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    if (state.items.length > 0) {
      // Keep what the user already has; report the failure without blanking.
      toast("error", `Could not refresh the list. ${err.message}`);
      state.phase = "ready";
    } else {
      state.phase = "error";
      state.errorMessage = err.message;
    }
    render();
  }
}

/* ---------------------------------------------------------------- render */

function render() {
  renderBanner();
  renderList();
  renderCount();
}

function renderBanner() {
  dom.bannerSlot.replaceChildren();
  if (state.phase !== "error") return;
  dom.bannerSlot.append(
    el(
      "div",
      { class: "banner", role: "alert" },
      icon("alert"),
      el("span", { class: "msg" }, `Could not load your tasks. ${state.errorMessage}`),
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => loadTasks() }, icon("refresh"), "Try again"),
    ),
  );
}

function renderList() {
  if (state.phase === "loading") return; // the skeleton (initial HTML) is showing
  if (state.phase === "error") {
    dom.listSlot.replaceChildren();
    return;
  }
  if (state.items.length === 0) {
    dom.listSlot.replaceChildren(emptyState());
    return;
  }

  const list = el("ul", { class: "task-list" }, state.items.map(taskRow));
  const nodes = [list];
  if (state.items.length < state.totalItems) {
    nodes.push(
      el(
        "div",
        { class: "load-more" },
        el(
          "button",
          { class: "btn btn-ghost", type: "button", onclick: (e) => { pending(e.currentTarget, true); loadTasks({ append: true }); } },
          `Show more (${state.totalItems - state.items.length} remaining)`,
        ),
      ),
    );
  }
  dom.listSlot.replaceChildren(...nodes);
}

function emptyState() {
  const copy = {
    all: ["No tasks yet", "Everything you add lands here — and your agent can add, update, and complete tasks for you."],
    todo: ["Nothing to do", "No tasks are waiting. Add one, or switch the filter to see the rest."],
    doing: ["Nothing in progress", "No tasks are marked as doing right now."],
    done: ["Nothing done yet", "Tasks you complete will collect here."],
  }[state.filter];

  const children = [
    el("span", { class: "empty-icon" }, icon("inbox", 32)),
    el("h2", {}, copy[0]),
    el("p", {}, copy[1]),
  ];
  if (state.filter === "all") {
    children.push(el("button", { class: "btn btn-primary", type: "button", onclick: () => dom.title.focus() }, icon("plus"), "Add your first task"));
  }
  return el("div", { class: "empty" }, ...children);
}

function taskRow(task) {
  const status = task.status ?? "todo";
  const row = el(
    "li",
    { class: `task${status === "done" ? " done" : ""}${state.busy.has(task.id) ? " busy" : ""}` },
    el(
      "button",
      {
        class: `status-btn status-${status}`,
        type: "button",
        title: `Mark as ${STATUS_LABEL[NEXT_STATUS[status]].toLowerCase()}`,
        "aria-label": `Status: ${STATUS_LABEL[status]}. Mark as ${STATUS_LABEL[NEXT_STATUS[status]].toLowerCase()}.`,
        onclick: () => advanceStatus(task),
      },
      STATUS_LABEL[status],
    ),
    el("span", { class: "title", title: task.title }, task.title),
    task.due
      ? el("span", { class: `due${isPastDay(task.due) && status !== "done" ? " overdue" : ""}` },
          isPastDay(task.due) && status !== "done" ? `Overdue · ${fmtDay(task.due)}` : `Due ${fmtDay(task.due)}`)
      : null,
    el(
      "button",
      { class: "btn-icon danger", type: "button", "aria-label": `Delete task "${task.title}"`, onclick: () => deleteTask(task) },
      icon("trash"),
    ),
  );
  return row;
}

function renderCount() {
  if (state.phase !== "ready") {
    dom.count.textContent = "";
    return;
  }
  const n = state.totalItems;
  const noun = n === 1 ? "task" : "tasks";
  dom.count.textContent =
    state.filter === "all" ? `${n} ${noun}` : `${n} ${STATUS_LABEL[state.filter].toLowerCase()} ${noun}`;
}

/* --------------------------------------------------------------- actions */

function pending(btn, on) {
  btn.classList.toggle("pending", on);
  btn.disabled = on;
}

function setTitleError(message) {
  dom.titleError.textContent = message ?? "";
  dom.titleError.hidden = !message;
  dom.title.setAttribute("aria-invalid", message ? "true" : "false");
}

dom.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = dom.title.value.trim();
  if (!title) {
    setTitleError("Give the task a title first.");
    dom.title.focus();
    return;
  }
  setTitleError(null);

  pending(dom.addBtn, true);
  try {
    const stored = await api(API, { method: "POST", body: JSON.stringify({ title, status: dom.status.value }) });
    // Trust the stored record, not the sent one.
    if (state.filter === "all" || stored.status === state.filter) {
      state.items = [stored, ...state.items];
    }
    state.totalItems += 1;
    state.phase = "ready";
    render();
    toast("success", `Added "${stored.title}".`);
    dom.title.value = "";
    dom.title.focus();
  } catch (err) {
    toast("error", `Could not add the task. ${err.message}`);
  } finally {
    pending(dom.addBtn, false);
  }
});

// Clear the inline error as soon as the user starts fixing it.
dom.title.addEventListener("input", () => setTitleError(null));

async function advanceStatus(task) {
  const next = NEXT_STATUS[task.status ?? "todo"];
  state.busy.add(task.id);
  render();
  try {
    const stored = await api(`${API}/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    if (state.filter !== "all" && stored.status !== state.filter) {
      // The record left this view; the count follows it.
      state.items = state.items.filter((t) => t.id !== task.id);
      state.totalItems -= 1;
    } else {
      state.items = state.items.map((t) => (t.id === task.id ? stored : t));
    }
  } catch (err) {
    toast("error", `Could not update "${task.title}". ${err.message}`);
  } finally {
    state.busy.delete(task.id);
    render();
  }
}

async function deleteTask(task) {
  const confirmed = await confirmDialog({
    title: "Delete this task?",
    body: `"${task.title}" will be removed permanently.`,
    confirmLabel: "Delete task",
    danger: true,
  });
  if (!confirmed) return;

  state.busy.add(task.id);
  render();
  try {
    await api(`${API}/${task.id}`, { method: "DELETE" });
    state.items = state.items.filter((t) => t.id !== task.id);
    state.totalItems -= 1;
    toast("success", `Deleted "${task.title}".`);
  } catch (err) {
    toast("error", `Could not delete "${task.title}". ${err.message}`);
  } finally {
    state.busy.delete(task.id);
    render();
  }
}

/* --------------------------------------------------------------- filters */

dom.filter.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn || btn.dataset.filter === state.filter) return;
  state.filter = btn.dataset.filter;
  for (const b of dom.filter.querySelectorAll("button[data-filter]")) {
    b.setAttribute("aria-pressed", b === btn ? "true" : "false");
  }
  state.items = [];
  loadTasks();
});

/* -------------------------------------------------------------- keyboard */

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
    e.preventDefault();
    dom.title.focus();
  }
});

/* ------------------------------------------------------- external changes */

// Someone else changed the data — an agent through A2App, or another tab. Re-read
// and re-render: the code we are running is current, so a reload would cost
// whatever is half-typed to fix a problem that was never about this page.
window.addEventListener("a2app:datachange", () => {
  if (hasUnsavedInput()) return; // the next write re-reads anyway
  loadTasks();
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  // Identity is fetched once per session — the header does not refetch what it has.
  api("/api/_a2app")
    .then((id) => {
      const name = id?.app?.name ?? "Tasks";
      dom.appName.textContent = name;
      document.title = name;
    })
    .catch(() => {
      /* the list's own error state reports reachability; the header keeps its default */
    });
  await loadTasks();
}

boot();
