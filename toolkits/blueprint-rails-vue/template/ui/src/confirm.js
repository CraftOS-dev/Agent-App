/**
 * The confirm composable (AGENT-OWNED). Pairs with
 * components/ConfirmDialog.vue — render the dialog once near the root of the
 * screen, then `await confirm({ title, body, confirmLabel, danger })`
 * resolves true on confirm. Callers pass real copy naming the target and
 * consequence, never "Are you sure?". Never `window.confirm`: everything
 * renders in the app's own design system.
 */
import { ref } from "vue";

export function useConfirm() {
  const request = ref(null);

  function confirm(opts) {
    return new Promise((resolve) => {
      request.value = { ...opts, resolve, opener: document.activeElement };
    });
  }

  // Focus returns to the opener when the dialog closes, whatever the answer.
  function done(answer) {
    const current = request.value;
    if (current) {
      current.resolve(answer);
      if (current.opener instanceof HTMLElement) current.opener.focus();
    }
    request.value = null;
  }

  return { request, confirm, done };
}
