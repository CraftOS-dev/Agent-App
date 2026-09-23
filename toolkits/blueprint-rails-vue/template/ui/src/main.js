/**
 * The View entry (AGENT-OWNED — edit freely to change the human UI).
 *
 * A Vue 3 SPA over the same records API the agent uses. Same-origin writes are
 * trusted by the adapter's origin rule, so the browser needs no token. A human
 * edits here; an agent operates the same data through A2App — both see each
 * other's changes on the next read.
 */
import { createApp } from "vue";
import App from "./App.vue";
// Importing the bridge starts the system-owned update watcher (see updater.js).
import "./updater.js";

createApp(App).mount("#app");
