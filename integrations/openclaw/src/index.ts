/**
 * Agent App Framework plugin for OpenClaw.
 *
 * OpenClaw loads a plugin via `definePluginEntry` and exposes an `api` that can
 * register tools, CLI subcommands, HTTP routes, and Control-UI tabs; it ships
 * folder-per-skill skills via `"skills": ["./skills"]` in the manifest. This
 * entry adapts that `api` to the framework's generic {@link HarnessContext} and
 * wires the framework in once — the same wiring as every other harness, only the
 * context shape differs.
 *
 * The deep route embeds the app in a Control-UI tab; the universal route (the
 * shipped `skills/`) works with zero code on any harness that reads SKILL.md.
 */
import { registerA2AppPlugin, showAgentApp, type HarnessContext } from "@a2app/integration-starter";

/** The subset of OpenClaw's plugin `api` we use (loosely typed — map to the real
 *  `@openclaw/plugin-sdk` types in your build). */
export interface OpenClawApi {
  registerTool(t: { name: string; description: string; parameters: unknown; handler: (a: Record<string, unknown>) => Promise<unknown> }): void;
  registerNodeCliFeature?(c: { name: string; run: (argv: string[]) => Promise<number> }): void;
  registerSkillsDir?(dir: string): void;
  session?: { controls?: { registerControlUiDescriptor(d: { surface: string; id: string; label: string; group: string; path: string }): void } };
  log?: (line: string) => void;
}

export function activate(api: OpenClawApi, opts: { skillsDir?: string; cliBin?: string } = {}): void {
  const ctx: HarnessContext = {
    registerTool: (t) => api.registerTool(t),
    ...(api.registerNodeCliFeature ? { registerCommand: (c) => api.registerNodeCliFeature!(c) } : {}),
    ...(api.registerSkillsDir ? { registerSkillsDir: (d) => api.registerSkillsDir!(d) } : {}),
    registerDisplay: (tab) =>
      api.session?.controls?.registerControlUiDescriptor({
        surface: "tab",
        id: tab.id,
        label: tab.label,
        group: "agent",
        path: `/__agent-app__/${encodeURIComponent(tab.id)}/`,
      }),
    ...(api.log ? { log: api.log } : {}),
  };
  registerA2AppPlugin(ctx, opts);
}

/** Call once an app is healthy to render it in a sandboxed Control-UI tab. */
export function display(api: OpenClawApi, app: { id: string; name: string; url: string }): void {
  const ctx: HarnessContext = {
    registerTool: () => {},
    registerDisplay: (tab) =>
      api.session?.controls?.registerControlUiDescriptor({ surface: "tab", id: tab.id, label: tab.label, group: "agent", path: tab.url }),
  };
  showAgentApp(ctx, app);
}
