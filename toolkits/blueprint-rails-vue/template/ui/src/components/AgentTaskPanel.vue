<!-- The full display of one agent run (AGENT-OWNED shared piece —
     @a2app-kit agent-task; see ../agentTask.js). Give it the whole width of
     its container — under a list row, not inside one of its cells. Every state
     renders:

       submitted        waiting, with elapsed time; after ~20 s unclaimed, says
                        no agent is listening and how to start one
       working          `progress.step` (and `percent` as a bar) and running time
       input-required   the agent is waiting on someone
       completed        `result.summary` in its own block: line breaks kept,
                        links clickable, long text clamped behind "Show more".
                        No summary (the bridge closed the task, not the
                        agent)? The run's printed output, labelled as such.
       failed/canceled  the `reason` in words (the queue's and bridge's own
                        codes are translated), and "Ask again" when the parent
                        listens for `retry`

     Emits `settled` (with the task) once, when a run it watched finishes, so
     the parent can re-read the data the agent wrote, and `status` whenever the
     task's status changes, so the parent can disable whatever queues more
     work while a run is open. -->
<script setup>
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { FINISHED, LABEL, TONE, fmtElapsed, reasonInWords, splitLinks, useAgentTask, useNow, viewOf } from "../agentTask.js";

const CLAMP_CHARS = 280;
const CLAMP_LINES = 4;

const props = defineProps({
  taskId: { type: String, default: null },
  progress: { type: Object, default: null },
  title: { type: String, default: "Agent" },
  canRetry: { type: Boolean, default: false },
  retrying: { type: Boolean, default: false },
  bridgeHint: { type: String, default: "agent-app <app-dir> bridge start" },
});
const emit = defineEmits(["settled", "retry", "status"]);

const state = useAgentTask(() => props.taskId);
const live = computed(() => Boolean(state.value.task && !FINISHED.has(state.value.task.status)));
const now = useNow(() => live.value);

watch(
  () => state.value.task?.status,
  (status, was) => {
    emit("status", status ?? null);
    if (status && FINISHED.has(status) && was && !FINISHED.has(was)) emit("settled", state.value.task);
  },
);

const view = computed(() => viewOf(state.value, props.progress, now.value));
const finished = computed(() => Boolean(view.value && FINISHED.has(view.value.key)));
const label = computed(() => (view.value ? (LABEL[view.value.key] ?? view.value.key) : ""));
const tone = computed(() => (view.value ? (TONE[view.value.key] ?? "neutral") : "neutral"));
const elapsedText = computed(() => {
  const e = view.value?.elapsed;
  if (e === null || e === undefined) return null;
  return finished.value ? `took ${fmtElapsed(e)}` : fmtElapsed(e);
});

const open = ref(false);
// No summary means the bridge closed the task from the run's exit; its printed
// output is then the only answer there is.
const fromOutput = computed(() => !view.value?.summary && Boolean(view.value?.output));
const summary = computed(() => view.value?.summary ?? view.value?.output ?? "");
const long = computed(() => summary.value.length > CLAMP_CHARS || summary.value.split("\n").length > CLAMP_LINES);
const parts = computed(() => splitLinks(summary.value));
const failure = computed(() => reasonInWords(view.value?.reason, view.value?.key === "canceled"));
</script>

<template>
  <template v-if="state.phase !== 'gone'">
    <div v-if="state.phase === 'loading' && !progress?.status" class="agent-task tone-neutral" aria-busy="true">
      <div class="agent-task-head">
        <span class="agent-dot" aria-hidden="true"></span>
        <span class="agent-task-state">Checking on the agent…</span>
      </div>
    </div>

    <div v-else-if="!view && state.phase === 'unauthorized'" class="agent-task tone-neutral" role="status">
      <p class="agent-task-note">
        This app needs sign-in to read the agent queue, so progress shows here only once the agent records it.
      </p>
    </div>

    <section v-else-if="view" class="agent-task" :class="[`tone-${tone}`, { live }]" :aria-label="`${title}: ${label}`">
      <div class="agent-task-head">
        <span class="agent-dot" aria-hidden="true"></span>
        <!-- The live region carries the state only; the ticking clock stays out of it. -->
        <span class="agent-task-state" role="status">
          {{ label }}<span v-if="view.step && !finished" class="agent-task-step"> — {{ view.step }}</span>
        </span>
        <span v-if="elapsedText" class="agent-task-elapsed" :aria-hidden="!finished">{{ elapsedText }}</span>
        <span v-if="state.phase === 'stale'" class="agent-task-elapsed">reconnecting…</span>
      </div>

      <div
        v-if="view.percent !== null && !finished"
        class="agent-task-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(view.percent)"
      >
        <span :style="{ width: `${Math.min(100, Math.max(0, view.percent))}%` }"></span>
      </div>

      <p v-if="view.key === 'unheard'" class="agent-task-note">
        Nothing has picked this up. Work is only delivered while an agent is listening — start one with
        <code>{{ bridgeHint }}</code>.
      </p>
      <p v-if="view.key === 'input-required'" class="agent-task-note">
        The agent is waiting for someone to answer it before it can continue.
      </p>

      <div v-if="view.key === 'completed' && summary" class="agent-result">
        <p v-if="fromOutput" class="agent-task-note">The agent sent no summary. This is what it printed:</p>
        <p class="agent-result-text" :class="{ clamped: long && !open }">
          <template v-for="(part, i) in parts" :key="i">
            <a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.href }}</a>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <button v-if="long" class="agent-result-toggle" type="button" :aria-expanded="open" @click="open = !open">
          {{ open ? "Show less" : "Show more" }}
        </button>
      </div>

      <div v-if="view.key === 'failed' || view.key === 'canceled'" class="agent-task-failure">
        <p class="agent-task-note">
          {{ failure.text }}<span v-if="failure.code" class="agent-task-code"> ({{ failure.code }})</span>
        </p>
        <button
          v-if="canRetry"
          class="btn btn-ghost"
          :class="{ pending: retrying }"
          type="button"
          :disabled="retrying"
          @click="emit('retry')"
        >
          <Icon name="refresh" />
          Ask again
        </button>
      </div>
    </section>
  </template>
</template>
