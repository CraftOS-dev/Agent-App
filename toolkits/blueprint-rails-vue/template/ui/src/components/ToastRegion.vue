<!-- The toast region (AGENT-OWNED). Rendered once near the root; screens push
     into it through useToast() (src/toast.js) and never re-implement it.
     A polite live region: assistive tech announces each toast without
     interrupting what the user is doing. -->
<script setup>
import Icon from "./Icon.vue";
import { toasts } from "../toast.js";

const iconOf = (kind) => (kind === "success" ? "check" : kind === "error" ? "alert" : "info");
</script>

<template>
  <div class="toast-region" aria-live="polite" role="status">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="[t.kind, { leaving: t.leaving }]">
      <span class="toast-icon"><Icon :name="iconOf(t.kind)" /></span>
      <span>{{ t.message }}</span>
    </div>
  </div>
</template>
