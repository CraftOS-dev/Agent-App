<!-- An in-app confirmation dialog (AGENT-OWNED). Names the specific target
     and consequence — callers pass real copy, never "Are you sure?". Never
     `window.confirm`: everything renders in the app's own design system.

     Keyboard: Tab cycles the two actions, Escape cancels, focus starts on the
     least destructive action; the useConfirm composable (src/confirm.js)
     returns focus to the opener when the dialog closes. -->
<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  title: { type: String, required: true },
  body: { type: String, required: true },
  confirmLabel: { type: String, required: true },
  danger: { type: Boolean, default: false },
});
const emit = defineEmits(["done"]);

const cancelBtn = ref(null);
const confirmBtn = ref(null);

function onKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("done", false);
  }
  if (e.key === "Tab") {
    // Two focus stops; wrap between them.
    e.preventDefault();
    (document.activeElement === cancelBtn.value ? confirmBtn.value : cancelBtn.value)?.focus();
  }
}

onMounted(() => {
  cancelBtn.value?.focus();
  document.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKey, true));

function onBackdrop(e) {
  if (e.target === e.currentTarget) emit("done", false);
}
</script>

<template>
  <div class="dialog-backdrop" @mousedown="onBackdrop">
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-body"
    >
      <h2 id="dialog-title">{{ props.title }}</h2>
      <p id="dialog-body">{{ props.body }}</p>
      <div class="dialog-actions">
        <button ref="cancelBtn" class="btn btn-ghost" type="button" @click="emit('done', false)">
          Cancel
        </button>
        <button
          ref="confirmBtn"
          class="btn"
          :class="props.danger ? 'btn-danger-solid' : 'btn-primary'"
          type="button"
          @click="emit('done', true)"
        >
          {{ props.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
