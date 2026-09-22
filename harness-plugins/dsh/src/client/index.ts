/**
 * Agent App Framework bundle for dsh, browser half.
 *
 * The manager appears as a **global sidebar panel**, which is dsh's own pattern
 * for a full surface of your own:
 *
 *   - a `main` (keyed) entry renders the manager in the centre column;
 *   - a `sidebar.panellist` (list) entry with the SAME id contributes the icon
 *     in the left sidebar, whose click selects that main panel
 *     (ui-sidebar/README: "The same id addresses the component registered in
 *     the layout's root-scoped `main` keyed slot").
 *
 * Selecting a Session or Workspace calls `layout.selectPanel(null)`, which
 * returns the centre column to the Conversation — so the panel is never a trap.
 *
 * The manager itself is served by the host half on dsh's web server and shown
 * in an iframe: same origin as the dsh UI, so its fetches and any embedded app
 * need no CORS. Chrome rendered inline in the dsh document styles itself with
 * dsh's `--dsw-*` tokens; the iframe cannot inherit those, so it is told the
 * mode through the route (`?light=1`).
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { createElement as h, type CSSProperties } from "react";

const HOME_ROUTE = "/agent-app/home";

/** Sidebar entry id AND main-panel key: one identity, two seats. */
const PANEL_ID = "agent-apps";
const LABEL = "Agent Apps";

/** Sidebar ordering: the shipped composition registers no panel, so any value is fine. */
const ORDER = 20;

const isDark = (): boolean => typeof document !== "undefined" && document.body.hasAttribute("data-ds-dark-theme");

const panel: CSSProperties = {
  // The frame's centre column is a flex column (`overflow: hidden`), so the
  // occupant grows as a flex item; height:100% would be the wrong axis.
  flex: "1 1 auto", display: "flex", flexDirection: "column",
  width: "100%", minHeight: 0, overflow: "hidden",
};
const frame: CSSProperties = {
  flex: "1 1 auto", width: "100%", minHeight: 0, border: "none",
  background: "var(--dsw-alias-bg-base, #fff)",
};

/** The centre-column panel: the manager page, filling the panel. */
function AgentAppsPanel(): ReturnType<typeof h> {
  const src = HOME_ROUTE + (isDark() ? "" : "?light=1");
  return h("div", { style: panel }, h("iframe", { src, style: frame, title: LABEL }));
}

/**
 * The sidebar glyph: a boxed cube.
 *
 * Hand-authored because dsh's icon set (`@deepseek-ai/dsh-client-ui-primitives`
 * — ~80 `ic_ds_*` glyphs) has no cube or package mark; the nearest shipped
 * glyphs, if you'd rather swap, are `IconArchiveOutline20` (a lidded box),
 * `IconDatabaseOutline16`, `IconDataOutline16` and `IconCordisPluginOutline14`.
 *
 * Drawn to the house conventions — 16 box, `fill="none"`, `currentColor`,
 * 1.25 stroke — so it sits at the same optical weight as the neighbouring
 * sidebar icons. The sidebar owns the button, label, tooltip and selected
 * styling; this draws only the mark, at the size the row asks for, and follows
 * the row's current colour.
 */
function AgentAppsIcon({ size, className }: { size?: number; className?: string }): ReturnType<typeof h> {
  const edge = size ?? 16;
  return h(
    "svg",
    {
      width: edge, height: edge, className, viewBox: "0 0 16 16", fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      stroke: "currentColor", strokeWidth: 1.25, strokeLinejoin: "round",
    },
    [
      // Three faces of one isometric cube: top, left, right.
      h("path", { key: "top", d: "M8 2.4 13.4 5.5 8 8.6 2.6 5.5Z" }),
      h("path", { key: "left", d: "M2.6 5.5 8 8.6V13.4L2.6 10.3Z" }),
      h("path", { key: "right", d: "M13.4 5.5V10.3L8 13.4V8.6Z" }),
    ],
  );
}

/** Required client services. */
export const inject = ["slots"];

/** The slice of dsh's slot service this registers through. */
interface SlotHost {
  slots: {
    /** Run the callback once the slot is declared, and again after a re-declaration. */
    inject(key: string, callback: () => () => void): () => void;
    register(options: unknown, component: unknown): () => void;
  };
}

/**
 * Claim the manager's two seats.
 *
 * Every registration goes through `slots.inject`, never a bare `slots.register`.
 * The client creates all entries CONCURRENTLY (boot-client.ts: Promise.all over
 * the rows) and `main` is declared by ui-layout while `sidebar.panellist` is
 * declared by ui-sidebar, so a direct register can run before either exists —
 * and SlotCore.register THROWS on an undeclared slot, which fails this whole
 * entry ("Failed to load plugins"). This bundle is prefetched via
 * `dsh.client.immediately`, so it applies early and tends to lose that race.
 */
export function apply(ctx: ClientContext): void {
  const slots = (ctx as unknown as SlotHost).slots;

  ctx.effect(
    () => slots.inject("main", () => slots.register({ name: "main", key: PANEL_ID }, AgentAppsPanel)),
    "agent-app: manager panel",
  );

  ctx.effect(
    () => slots.inject("sidebar.panellist", () => slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: ORDER, label: LABEL },
      AgentAppsIcon,
    )),
    "agent-app: sidebar entry",
  );
}

// Deliberately NO `export default` — see the host half: dsh's Loader unwraps
// `exports.default ?? exports`, so a default export would drop `inject: ["slots"]`
// and every `ctx.slots` access would throw.
