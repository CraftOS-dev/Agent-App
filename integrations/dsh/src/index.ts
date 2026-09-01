/**
 * Agent App Framework bundle for deepseek-harness (dsh).
 *
 * dsh is everything-is-a-plugin (Cordis bundles): the host half registers tools
 * on `ctx.tools` and jobs on `ctx.jobs`, gated by `ctx.approval`; the browser
 * half is a `dsh.client` module that renders in its own slot. dsh has no
 * first-class embedding surface, so display is DIY — a built client bundle can
 * render `<iframe src="http://127.0.0.1:<port>">` (the fetch/DOM restrictions
 * apply only to model-authored dynamic modules, not to a shipped bundle).
 *
 * This is the host half; `client.ts` is the browser half.
 */
import { registerA2AppPlugin, type HarnessContext } from "@a2app/integration-starter";

/** The subset of a dsh Cordis `ctx` we use (map to the real dsh types). */
export interface DshContext {
  tools: { register(t: { name: string; description: string; parameters: unknown; handler: (a: Record<string, unknown>) => Promise<unknown> }): void };
  shell?: { register(c: { name: string; run: (argv: string[]) => Promise<number> }): void };
  skills?: { addDir(dir: string): void };
  logger?: { info(line: string): void };
}

export function apply(ctx: DshContext, opts: { skillsDir?: string; cliBin?: string } = {}): void {
  const adapter: HarnessContext = {
    registerTool: (t) => ctx.tools.register(t),
    ...(ctx.shell ? { registerCommand: (c) => ctx.shell!.register(c) } : {}),
    ...(ctx.skills ? { registerSkillsDir: (d) => ctx.skills!.addDir(d) } : {}),
    ...(ctx.logger ? { log: (line: string) => ctx.logger!.info(line) } : {}),
  };
  registerA2AppPlugin(adapter, opts);
}

export default apply;
