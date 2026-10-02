<!-- A compact state pill for a list row, so someone can leave the screen and
     come back (AGENT-OWNED shared piece — @a2app-kit agent-task; see
     ../agentTask.js). -->
<script setup>
import { computed } from "vue";
import { FINISHED, LABEL, TONE, useAgentTask, useNow, viewOf } from "../agentTask.js";

const props = defineProps({
  taskId: { type: String, default: null },
  progress: { type: Object, default: null },
});

const state = useAgentTask(() => props.taskId);
const live = computed(() => Boolean(state.value.task && !FINISHED.has(state.value.task.status)));
const now = useNow(() => live.value);
const view = computed(() => (state.value.phase === "gone" ? null : viewOf(state.value, props.progress, now.value)));
const label = computed(() => (view.value ? (LABEL[view.value.key] ?? view.value.key) : ""));
</script>

<template>
  <span
    v-if="view"
    class="agent-badge"
    :class="[`tone-${TONE[view.key] ?? 'neutral'}`, { live }]"
    :title="label"
  >
    <span class="agent-dot" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>
