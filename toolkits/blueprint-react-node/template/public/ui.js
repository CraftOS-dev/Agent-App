/**
 * UI component library (AGENT-OWNED). One implementation per widget — screens
 * compose these; they never re-implement them. Everything renders in the app's
 * own design system (tokens.css + ui.css): dialogs, toasts, and icons included,
 * so no native browser chrome ever stands in for the app's interface.
 */

/* ------------------------------------------------------------------ dom */

/** Build an element: el("button", { class: "btn", onclick: fn }, "Save"). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------------------------------------------------------------- icons */

// One consistent inline-SVG icon set (16px grid, stroke-based). Icons are
// decorative beside their text label, so they are aria-hidden; icon-only
// buttons carry an aria-label instead.
const ICON_PATHS = {
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5 6.5 12 13 4.5",
  trash: "M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5m2.5 0V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5",
  alert: "M8 5.5V9m0 2.5v.01M8 1.5 1.5 13.5h13L8 1.5Z",
  info: "M8 7.5V11m0-5.5v-.01M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  inbox: "M1.5 9.5h3l1 2h5l1-2h3M2.5 3.5h11l1 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3l1-6Z",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6",
};

/** An inline SVG icon from the app's set. */
export function icon(name, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name] ?? ICON_PATHS.info);
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/* ---------------------------------------------------------------- toasts */

let toastRegion = null;

function ensureToastRegion() {
  if (!toastRegion) {
    // Polite live region: assistive tech announces each toast without
    // interrupting what the user is doing.
    toastRegion = el("div", { class: "toast-region", "aria-live": "polite", role: "status" });
    document.body.append(toastRegion);
  }
  return toastRegion;
}

/** Show a transient acknowledgment: toast("success", "Task added"). */
export function toast(kind, message, { duration = 3500 } = {}) {
  const region = ensureToastRegion();
  const iconName = kind === "success" ? "check" : kind === "error" ? "alert" : "info";
  const node = el(
    "div",
    { class: `toast ${kind}` },
    el("span", { class: "toast-icon" }, icon(iconName)),
    el("span", {}, message),
  );
  region.append(node);
  // Errors linger longer: reading "what happened + what to do" takes time.
  const ms = kind === "error" ? Math.max(duration, 6000) : duration;
  setTimeout(() => {
    node.classList.add("leaving");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    // Reduced-motion collapses the transition to ~0ms; remove regardless.
    setTimeout(() => node.remove(), 400);
  }, ms);
  return node;
}

/* ---------------------------------------------------------------- dialog */

/**
 * An in-app confirmation dialog. Names the specific target and consequence —
 * callers pass real copy, never "Are you sure?". Resolves true on confirm.
 *
 * Keyboard: Tab cycles the two actions, Escape cancels, focus starts on the
 * least destructive action and returns to the opener when the dialog closes.
 */
export function confirmDialog({ title, body, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;

    const done = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (opener instanceof HTMLElement) opener.focus();
      resolve(answer);
    };

    const cancelBtn = el("button", { class: "btn btn-ghost", type: "button", onclick: () => done(false) }, "Cancel");
    const confirmBtn = el(
      "button",
      { class: `btn ${danger ? "btn-danger-solid" : "btn-primary"}`, type: "button", onclick: () => done(true) },
      confirmLabel,
    );

    const dialog = el(
      "div",
      { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "dialog-title", "aria-describedby": "dialog-body" },
      el("h2", { id: "dialog-title" }, title),
      el("p", { id: "dialog-body" }, body),
      el("div", { class: "dialog-actions" }, cancelBtn, confirmBtn),
    );
    const backdrop = el("div", { class: "dialog-backdrop", onmousedown: (e) => { if (e.target === backdrop) done(false); } }, dialog);

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      if (e.key === "Tab") {
        // Two focus stops; wrap between them.
        e.preventDefault();
        (document.activeElement === cancelBtn ? confirmBtn : cancelBtn).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    document.body.append(backdrop);
    cancelBtn.focus();
  });
}

/* ------------------------------------------------------------- formatting */

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DATE_FMT_Y = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** A day key ("2026-03-14") formatted for reading; adds the year only when it differs. */
export function fmtDay(dayKey) {
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  return (d.getFullYear() === new Date().getFullYear() ? DATE_FMT : DATE_FMT_Y).format(d);
}

/** True when a day key is strictly before today (local time). */
export function isPastDay(dayKey) {
  const d = new Date(`${dayKey}T23:59:59`);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}
