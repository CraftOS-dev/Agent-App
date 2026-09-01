/**
 * Agent App Framework integration for the CraftBot harness.
 *
 * Adapts CraftBot's action/command/display surface to the framework's generic
 * {@link HarnessContext}: it registers agent tools that wrap the `a2app` CLI,
 * mounts the skills directory, and renders a running app in CraftBot's iframe
 * pool — the same wiring every harness plugin uses.
 */
import { registerA2AppPlugin, showAgentApp, type HarnessContext } from "@a2app/integration-starter";

/** The subset of CraftBot's host surface we use. */
export interface CraftBotHost {
  registerAction(a: { name: string; description: string; schema: unknown; run: (a: Record<string, unknown>) => Promise<unknown> }): void;
  registerCommand?(c: { name: string; run: (argv: string[]) => Promise<number> }): void;
  registerSkillsDir?(dir: string): void;
  openInIframePool?(app: { id: string; label: string; url: string }): void;
  log?: (line: string) => void;
}

export function install(host: CraftBotHost, opts: { skillsDir?: string; cliBin?: string } = {}): void {
  const ctx: HarnessContext = {
    registerTool: (t) => host.registerAction({ name: t.name, description: t.description, schema: t.parameters, run: t.handler }),
    ...(host.registerCommand ? { registerCommand: (c) => host.registerCommand!(c) } : {}),
    ...(host.registerSkillsDir ? { registerSkillsDir: (d) => host.registerSkillsDir!(d) } : {}),
    ...(host.openInIframePool ? { registerDisplay: (tab) => host.openInIframePool!({ id: tab.id, label: tab.label, url: tab.url }) } : {}),
    ...(host.log ? { log: host.log } : {}),
  };
  registerA2AppPlugin(ctx, opts);
}

/** Render a healthy app in CraftBot's iframe pool. */
export function display(host: CraftBotHost, app: { id: string; name: string; url: string }): void {
  const ctx: HarnessContext = {
    registerTool: () => {},
    ...(host.openInIframePool ? { registerDisplay: (tab) => host.openInIframePool!({ id: tab.id, label: tab.label, url: tab.url }) } : {}),
  };
  showAgentApp(ctx, app);
}
