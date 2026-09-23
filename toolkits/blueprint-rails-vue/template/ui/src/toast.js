/**
 * Toasts (AGENT-OWNED). One implementation for the whole app — screens call
 * `useToast()(kind, message)`; they never re-implement the region. The shared
 * reactive list is rendered once by components/ToastRegion.vue. Everything
 * renders in the app's own design system (tokens.css + ui.css), so no native
 * browser chrome ever stands in for the app's interface.
 */
import { reactive } from "vue";

/** The one toast list; ToastRegion.vue renders it. */
export const toasts = reactive([]);

let nextToastId = 0;

/** The push function: `toast(kind, message)`. Kinds: success · error · info. */
export function useToast() {
  return (kind, message, { duration = 3500 } = {}) => {
    const id = ++nextToastId;
    toasts.push({ id, kind, message, leaving: false });
    // Errors linger longer: reading "what happened + what to do" takes time.
    const ms = kind === "error" ? Math.max(duration, 6000) : duration;
    setTimeout(() => {
      const toast = toasts.find((t) => t.id === id);
      if (toast) toast.leaving = true;
      // Reduced-motion collapses the transition to ~0ms; remove regardless.
      setTimeout(() => {
        const index = toasts.findIndex((t) => t.id === id);
        if (index !== -1) toasts.splice(index, 1);
      }, 400);
    }, ms);
  };
}
