/**
 * Agent App Framework plugin for Hermes.
 *
 * Hermes loads a plugin via `plugin.yaml` + a `register(ctx)` entry; `ctx`
 * registers tools, CLI commands, hooks, and dashboard tabs, gated by capability
 * consent. Its desktop build can open and drive a localhost app in the preview
 * pane with no harness changes. This entry adapts `ctx` to the framework's
 * generic {@link HarnessContext}.
 */
import { registerA2AppPlugin, showAgentApp, type HarnessContext } from "@a2app/integration-starter";

/** The subset of Hermes' `PluginContext` we use (map to the real hermes types). */
export interface HermesContext {
  register_tool(t: { name: string; description: string; parameters: unknown; handler: (a: Record<string, unknown>) => Promise<unknown> }): void;
  register_cli_command?(c: { name: string; run: (argv: string[]) => Promise<number> }): void;
  register_skills_dir?(dir: string): void;
  open_preview?(url: string, opts?: { label?: string }): void;
  log?: (line: string) => void;
}

/** Hermes calls this on load. */
export function register(ctx: HermesContext, opts: { skillsDir?: string; cliBin?: string } = {}): void {
  const adapter: HarnessContext = {
    registerTool: (t) => ctx.register_tool(t),
    ...(ctx.register_cli_command ? { registerCommand: (c) => ctx.register_cli_command!(c) } : {}),
    ...(ctx.register_skills_dir ? { registerSkillsDir: (d) => ctx.register_skills_dir!(d) } : {}),
    ...(ctx.open_preview ? { registerDisplay: (tab) => ctx.open_preview!(tab.url, { label: tab.label }) } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
  };
  registerA2AppPlugin(adapter, opts);
}

/** Open a healthy app in the Hermes desktop preview pane. */
export function preview(ctx: HermesContext, app: { id: string; name: string; url: string }): void {
  const adapter: HarnessContext = {
    registerTool: () => {},
    ...(ctx.open_preview ? { registerDisplay: (tab) => ctx.open_preview!(tab.url, { label: tab.label }) } : {}),
  };
  showAgentApp(adapter, app);
}
