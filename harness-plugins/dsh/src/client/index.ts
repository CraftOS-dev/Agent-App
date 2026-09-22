/**
 * Agent App Framework bundle for dsh, browser half.
 *
 * dsh has no plugin-addable top-level tab, so the manager lives in the frame's
 * additive `shell.overlay` slot: a floating launcher pill that opens the
 * full-screen manager. The manager itself is served by the host half over dsh's
 * web server and shown here in an iframe (same origin as the dsh UI, so its own
 * fetches and any embedded app work normally). This chrome renders inline in the
 * dsh document, so it styles itself with dsh's own `--dsw-*` tokens and follows
 * the host's dark/light mode; the manager iframe cannot inherit those, so it is
 * told the mode through the route (`?light=1`).
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { createElement as h, useState, type CSSProperties } from "react";

const HOME_ROUTE = "/agent-app/home";
const isDark = (): boolean => typeof document !== "undefined" && document.body.hasAttribute("data-ds-dark-theme");

const pill: CSSProperties = {
  position: "fixed", right: "20px", bottom: "20px", zIndex: 40,
  display: "inline-flex", alignItems: "center", gap: "8px",
  height: "40px", padding: "0 16px", borderRadius: "9999px", border: "none",
  background: "var(--dsw-alias-button-primary-fill, rgb(65,118,230))",
  color: "var(--dsw-alias-label-primary-foreground, #fff)",
  font: "500 14px/1 var(--dsw-font-family, sans-serif)", cursor: "pointer",
  boxShadow: "var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18))",
};
const overlay: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 40,
  background: "var(--dsw-alias-bg-base, rgb(21,21,23))",
  display: "flex", flexDirection: "column",
};
const bar: CSSProperties = {
  flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between",
  height: "44px", padding: "0 14px",
  borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))",
  color: "var(--dsw-alias-label-primary, inherit)", font: "600 13px/1 var(--dsw-font-family, sans-serif)",
};
const closeBtn: CSSProperties = {
  border: "none", background: "transparent", color: "inherit",
  width: "28px", height: "28px", borderRadius: "8px", cursor: "pointer", fontSize: "16px", lineHeight: 1,
};
const frame: CSSProperties = { flex: 1, width: "100%", border: "none" };

/** The overlay entry: a launcher pill that expands to the full manager. */
function AgentAppsOverlay(): ReturnType<typeof h> {
  const [open, setOpen] = useState(false);
  if (!open) {
    return h("button", { style: pill, onClick: () => setOpen(true), title: "Agent Apps" }, "Agent Apps");
  }
  const src = HOME_ROUTE + (isDark() ? "" : "?light=1");
  return h("div", { style: overlay }, [
    h("div", { style: bar, key: "bar" }, [
      h("span", { key: "t" }, "Agent Apps"),
      h("button", { key: "x", style: closeBtn, onClick: () => setOpen(false), title: "Close" }, "✕"),
    ]),
    h("iframe", { key: "f", src, style: frame, title: "Agent Apps" }),
  ]);
}

/** Required client services. */
export const inject = ["slots"];

/** Contribute the launcher/manager into the frame's overlay slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => (ctx as unknown as { slots: { register(o: unknown, c: unknown): () => void } }).slots.register(
      { name: "shell.overlay", id: "agent-app-manager" },
      AgentAppsOverlay,
    ),
    "agent-app: overlay slot",
  );
}

export default apply;
