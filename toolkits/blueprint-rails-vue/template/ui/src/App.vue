<!-- The View (AGENT-OWNED — edit freely to change the human UI).

     A Vue 3 SPA over the same records API the agent uses. Screens compose the
     shared pieces (Icon, ToastRegion + useToast, ConfirmDialog + useConfirm)
     and the tokens in ui/public/tokens.css; every region renders all of its
     states (loading, empty, error, list), every action acknowledges
     immediately, and every success is read back from what the server STORED —
     never assumed from what was sent.

     External changes: the system-owned update watcher reports two kinds of
     staleness. A CODE change it handles itself (reload when nothing is
     unsaved). A DATA change it only announces (`a2app:datachange`) — because
     only this file knows how to re-read without discarding a form someone is
     filling in. -->
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "./api.js";
import { hasUnsavedInput } from "./updater.js";
import { useToast } from "./toast.js";
import { useConfirm } from "./confirm.js";
import { STATUS_LABEL, NEXT_STATUS, fmtDay, isPastDay } from "./format.js";
import Icon from "./components/Icon.vue";
import ToastRegion from "./components/ToastRegion.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";

const API = "/api/collections/tasks/records";
const PER_PAGE = 100; // the client never renders an unbounded collection
const FILTERS = ["all", "todo", "doing", "done"];

const EMPTY_COPY = {
  all: ["No tasks yet", "Everything you add lands here — and your agent can add, update, and complete tasks for you."],
  todo: ["Nothing to do", "No tasks are waiting. Add one, or switch the filter to see the rest."],
  doing: ["Nothing in progress", "No tasks are marked as doing right now."],
  done: ["Nothing done yet", "Tasks you complete will collect here."],
};

const SKELETON_ROWS = [1, 0.7, 0.85];

const toast = useToast();
const { request: confirmRequest, confirm, done: confirmDone } = useConfirm();

const appName = ref("Tasks");
const items = ref([]);
const totalItems = ref(0);
const filter = ref("all");
const phase = ref("loading"); // loading | ready | error
const errorMessage = ref("");
const busy = ref(new Set()); // record ids with a write in flight
const adding = ref(false);
const loadingMore = ref(false);
const title = ref("");
const status = ref("todo");
const titleError = ref(null);

const titleInput = ref(null);
let loadSeq = 0; // drops stale responses when filters change quickly

/* ------------------------------------------------------------------ load */

async function loadTasks({ append = false, filter: forFilter } = {}) {
  const active = forFilter ?? filter.value;
  const seq = ++loadSeq;
  if (!append && items.value.length === 0) phase.value = "loading";
  const page = append ? Math.floor(items.value.length / PER_PAGE) + 1 : 1;
  const params = new URLSearchParams({ sort: "-created", page: String(page), perPage: String(PER_PAGE) });
  if (active !== "all") params.set("filter", `status = "${active}"`);

  try {
    const res = await api(`${API}?${params}`);
    if (seq !== loadSeq) return; // a newer load superseded this one
    items.value = append ? [...items.value, ...(res.items ?? [])] : (res.items ?? []);
    totalItems.value = res.totalItems ?? (res.items ?? []).length;
    phase.value = "ready";
  } catch (err) {
    if (seq !== loadSeq) return;
    if (items.value.length > 0) {
      // Keep what the user already has; report the failure without blanking.
      toast("error", `Could not refresh the list. ${err.message}`);
      phase.value = "ready";
    } else {
      errorMessage.value = err.message;
      phase.value = "error";
    }
  }
}

/* ------------------------------------------------------------------ boot */

const onDataChange = async () => {
  // Someone else changed the data — an agent through A2App, or another tab.
  // Re-read and re-render: the code we are running is current, so a reload
  // would cost whatever is half-typed to fix a problem that was never about
  // this page.
  if (await hasUnsavedInput()) return; // the next write re-reads anyway
  loadTasks();
};

const onKey = (e) => {
  if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
    e.preventDefault();
    titleInput.value?.focus();
  }
};

onMounted(() => {
  // Identity is fetched once per session — the header does not refetch what it has.
  api("/api/_a2app")
    .then((id) => {
      const name = id?.app?.name ?? "Tasks";
      appName.value = name;
      document.title = name;
    })
    .catch(() => {
      /* the list's own error state reports reachability; the header keeps its default */
    });
  loadTasks();
  window.addEventListener("a2app:datachange", onDataChange);
  document.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("a2app:datachange", onDataChange);
  document.removeEventListener("keydown", onKey);
});

/* --------------------------------------------------------------- actions */

function markBusy(id, on) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

function changeFilter(next) {
  if (next === filter.value) return;
  filter.value = next;
  items.value = []; // loadTasks reads this synchronously for paging
  loadTasks({ filter: next });
}

async function onSubmit() {
  const trimmed = title.value.trim();
  if (!trimmed) {
    titleError.value = "Give the task a title first.";
    titleInput.value?.focus();
    return;
  }
  titleError.value = null;
  adding.value = true;
  try {
    const stored = await api(API, { method: "POST", body: JSON.stringify({ title: trimmed, status: status.value }) });
    // Trust the stored record, not the sent one.
    if (filter.value === "all" || stored.status === filter.value) {
      items.value = [stored, ...items.value];
    }
    totalItems.value += 1;
    phase.value = "ready";
    toast("success", `Added "${stored.title}".`);
    title.value = "";
    titleInput.value?.focus();
  } catch (err) {
    toast("error", `Could not add the task. ${err.message}`);
  } finally {
    adding.value = false;
  }
}

async function advanceStatus(task) {
  const next = NEXT_STATUS[st(task)];
  markBusy(task.id, true);
  try {
    const stored = await api(`${API}/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    if (filter.value !== "all" && stored.status !== filter.value) {
      // The record left this view; the count follows it.
      items.value = items.value.filter((t) => t.id !== task.id);
      totalItems.value -= 1;
    } else {
      items.value = items.value.map((t) => (t.id === task.id ? stored : t));
    }
  } catch (err) {
    toast("error", `Could not update "${task.title}". ${err.message}`);
  } finally {
    markBusy(task.id, false);
  }
}

async function deleteTask(task) {
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
    items.value = items.value.filter((t) => t.id !== task.id);
    totalItems.value -= 1;
    toast("success", `Deleted "${task.title}".`);
  } catch (err) {
    toast("error", `Could not delete "${task.title}". ${err.message}`);
  } finally {
    markBusy(task.id, false);
  }
}

async function showMore() {
  loadingMore.value = true;
  try {
    await loadTasks({ append: true });
  } finally {
    loadingMore.value = false;
  }
}

function focusTitle() {
  titleInput.value?.focus();
}

/* ---------------------------------------------------------------- render */

// status: a labelled 3-state control; colour is never the only channel.
const st = (task) => task.status ?? "todo";
const nextLabel = (task) => STATUS_LABEL[NEXT_STATUS[st(task)]].toLowerCase();
const statusAria = (task) => `Status: ${STATUS_LABEL[st(task)]}. Mark as ${nextLabel(task)}.`;
const deleteAria = (task) => `Delete task "${task.title}"`;
const isOverdue = (task) => Boolean(task.due) && isPastDay(task.due) && st(task) !== "done";

const count = computed(() => {
  if (phase.value !== "ready") return "";
  if (filter.value === "all") return `${totalItems.value} ${totalItems.value === 1 ? "task" : "tasks"}`;
  return `${totalItems.value} ${STATUS_LABEL[filter.value].toLowerCase()} ${totalItems.value === 1 ? "task" : "tasks"}`;
});
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>{{ appName }}</h1>
      <p class="subtitle">Your list, shared with your agent — changes on either side show up on both.</p>
    </header>

    <main>
      <section class="card" aria-label="Add a task">
        <form class="add-form" novalidate @submit.prevent="onSubmit">
          <div class="field">
            <label class="sr-only" for="new-title">Task title</label>
            <input
              id="new-title"
              ref="titleInput"
              v-model="title"
              class="input"
              type="text"
              maxlength="200"
              autocomplete="off"
              placeholder="What needs doing?"
              aria-describedby="title-error"
              :aria-invalid="titleError ? 'true' : 'false'"
              @input="titleError = null"
            />
            <!-- The inline error clears as soon as the user starts fixing it. -->
            <p id="title-error" class="field-error" :hidden="!titleError">{{ titleError }}</p>
          </div>
          <div class="field">
            <label class="sr-only" for="new-status">Initial status</label>
            <select id="new-status" v-model="status" class="select">
              <option value="todo">To do</option>
              <option value="doing">Doing</option>
              <option value="done">Done</option>
            </select>
          </div>
          <button class="btn btn-primary" :class="{ pending: adding }" type="submit" :disabled="adding">
            Add task
          </button>
        </form>
      </section>

      <div class="toolbar">
        <div class="seg" role="group" aria-label="Filter tasks by status">
          <button
            v-for="f in FILTERS"
            :key="f"
            type="button"
            :aria-pressed="filter === f"
            @click="changeFilter(f)"
          >
            {{ f === "all" ? "All" : STATUS_LABEL[f] }}
          </button>
        </div>
      </div>

      <div v-if="phase === 'error'" class="banner" role="alert">
        <Icon name="alert" />
        <span class="msg">Could not load your tasks. {{ errorMessage }}</span>
        <button class="btn btn-ghost" type="button" @click="loadTasks()">
          <Icon name="refresh" />
          Try again
        </button>
      </div>

      <section class="card" aria-label="Tasks">
        <!-- First-paint placeholder. Row heights match the real rows so
             arriving content does not shift the layout. -->
        <div v-if="phase === 'loading'">
          <div v-for="(flex, i) in SKELETON_ROWS" :key="i" class="skel-row">
            <span class="skel" style="width: 24px; height: 24px; border-radius: 9999px"></span>
            <span class="skel" :style="{ flex: String(flex), height: '14px' }"></span>
            <span class="skel" style="width: 56px; height: 24px; border-radius: 9999px"></span>
          </div>
        </div>

        <div v-else-if="phase === 'ready' && items.length === 0" class="empty">
          <span class="empty-icon"><Icon name="inbox" :size="32" /></span>
          <h2>{{ EMPTY_COPY[filter][0] }}</h2>
          <p>{{ EMPTY_COPY[filter][1] }}</p>
          <button v-if="filter === 'all'" class="btn btn-primary" type="button" @click="focusTitle">
            <Icon name="plus" />
            Add your first task
          </button>
        </div>

        <template v-else-if="phase === 'ready'">
          <ul class="task-list">
            <li
              v-for="task in items"
              :key="task.id"
              class="task"
              :class="{ done: st(task) === 'done', busy: busy.has(task.id) }"
            >
              <button
                class="status-btn"
                :class="`status-${st(task)}`"
                type="button"
                :title="`Mark as ${nextLabel(task)}`"
                :aria-label="statusAria(task)"
                @click="advanceStatus(task)"
              >
                {{ STATUS_LABEL[st(task)] }}
              </button>
              <span class="title" :title="task.title">{{ task.title }}</span>
              <span v-if="task.due" class="due" :class="{ overdue: isOverdue(task) }">
                {{ isOverdue(task) ? `Overdue · ${fmtDay(task.due)}` : `Due ${fmtDay(task.due)}` }}
              </span>
              <button class="btn-icon danger" type="button" :aria-label="deleteAria(task)" @click="deleteTask(task)">
                <Icon name="trash" />
              </button>
            </li>
          </ul>
          <div v-if="items.length < totalItems" class="load-more">
            <button
              class="btn btn-ghost"
              :class="{ pending: loadingMore }"
              type="button"
              :disabled="loadingMore"
              @click="showMore"
            >
              Show more ({{ totalItems - items.length }} remaining)
            </button>
          </div>
        </template>
      </section>
    </main>

    <footer class="app-footer">
      <span aria-live="polite">{{ count }}</span>
      <span class="hint">Press / to add a task</span>
    </footer>

    <ConfirmDialog
      v-if="confirmRequest"
      :title="confirmRequest.title"
      :body="confirmRequest.body"
      :confirm-label="confirmRequest.confirmLabel"
      :danger="confirmRequest.danger"
      @done="confirmDone"
    />
    <ToastRegion />
  </div>
</template>
