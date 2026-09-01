/**
 * The View (AGENT-OWNED — edit freely to change the human UI).
 *
 * A dependency-free SPA over the same records API the agent uses. Same-origin
 * writes are trusted by the adapter's origin rule, so the browser needs no
 * token. A human edits here; an agent operates the same data through A2App —
 * both see each other's changes on the next read.
 */
const API = "/api/collections/tasks/records";

const els = {
  name: document.getElementById("appname"),
  form: document.getElementById("add"),
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  list: document.getElementById("list"),
  foot: document.getElementById("foot"),
};

async function api(path, init) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.text();
  const json = body ? JSON.parse(body) : null;
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
  return json;
}

async function load() {
  const id = await api("/api/_a2app");
  els.name.textContent = id.app?.name ?? "Tasks";
  document.title = `${els.name.textContent} — Agent App`;

  const { items = [] } = await api(`${API}?sort=-created`);
  render(items);
}

function render(items) {
  els.list.innerHTML = "";
  for (const t of items) {
    const li = document.createElement("li");
    if (t.status === "done") li.className = "done";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = t.title;

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = t.status ?? "todo";

    const next = document.createElement("button");
    next.className = "pill";
    next.title = "Advance status";
    next.textContent = "↻";
    next.addEventListener("click", () => advance(t));

    const del = document.createElement("button");
    del.className = "x";
    del.title = "Delete";
    del.textContent = "✕";
    del.addEventListener("click", () => remove(t.id));

    li.append(title, pill, next, del);
    els.list.append(li);
  }
  els.foot.textContent = `${items.length} task${items.length === 1 ? "" : "s"} · a human and an agent share this list.`;
}

const NEXT = { todo: "doing", doing: "done", done: "todo" };

async function advance(t) {
  await api(`${API}/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: NEXT[t.status ?? "todo"] }) });
  await load();
}

async function remove(id) {
  await api(`${API}/${id}`, { method: "DELETE" });
  await load();
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = els.title.value.trim();
  if (!title) return;
  await api(API, { method: "POST", body: JSON.stringify({ title, status: els.status.value }) });
  els.title.value = "";
  await load();
});

load().catch((e) => {
  els.foot.textContent = `Could not load: ${e.message}`;
});
