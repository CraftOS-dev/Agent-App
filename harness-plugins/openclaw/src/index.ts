/**
 * Agent App Framework plugin for OpenClaw.
 *
 * A real OpenClaw plugin: it registers an `/agent-app` chat command (the action
 * path that hands a request to the agent), an `openclaw agent-app …` CLI
 * passthrough, a read-only Control UI tab serving the framework's entry form,
 * and ships the six framework skills. The agent surface is the skills + CLIs
 * (the universal route); this plugin deliberately registers no agent tools.
 *
 * The Control UI frames plugin pages behind a GET/HEAD-only auth grant in an
 * opaque-origin sandbox (no forms, no clipboard), so the tab never mutates
 * anything: the form composes a kickoff prompt server-side from query
 * parameters and the user carries it into chat — where the `/agent-app`
 * command (with standing agent-prompt guidance) routes it to the right skill.
 *
 * Built by `pnpm --filter @a2app/integration-openclaw build`, which bundles this
 * entry (engine inlined, `openclaw/plugin-sdk/*` external) into `dist/` together
 * with the manifest, a generated package.json, and the skills — `dist/` is the
 * installable plugin: `openclaw plugins install ./harness-plugins/openclaw/dist`.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runA2App, binFor, agentAppFormHtml, buildKickoffPrompt, listKnownApps } from "@a2app/integration-starter";

/** The a2app binary (or JS entry) to shell. Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. The operate client rejects build verbs by design
 *  (framework spec 5.1), so `binFor` routes each verb to its owner. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

/** Standing system-prompt guidance registered with the `/agent-app` command, so
 *  the agent routes a request through the framework skills instead of building
 *  or operating from general knowledge. */
const AGENT_GUIDANCE =
  "The /agent-app command is the front door to the Agent App Framework. An Agent App is a " +
  "self-contained full-stack web app operated through its A2App adapter (the `a2app` CLI) — " +
  "never by driving the UI. When a message asks to build, change, run, import, verify, or " +
  "connect to an app, load the matching framework skill and follow it end to end: creator " +
  "(build a NEW app), modify (change an EXISTING app), operator (use/read/run an app, no code " +
  "changes), importer (adopt existing software), walk-verify (independent verification), " +
  "connect (a published app you do not own). Do not build or operate an app from general " +
  "knowledge outside these skills. `agent-app list` locates every known Agent App.";

export default definePluginEntry({
  id: "a2app",
  name: "Agent App Framework",
  description: "Build and operate full Agent Apps over the A2App protocol via the agent-app and a2app CLIs.",
  register(api) {
    // The chat command — the action path. `continueAgent: true` lets the message
    // fall through to the agent turn, where AGENT_GUIDANCE routes it to a skill.
    api.registerCommand({
      name: "agent-app",
      description: "Build, evolve, or operate an Agent App — routes the request to the right framework skill.",
      acceptsArgs: true,
      agentPromptGuidance: [AGENT_GUIDANCE],
      handler(ctx: { args?: string }) {
        if (!(ctx.args ?? "").trim()) {
          return {
            text:
              "Usage: /agent-app <what you want>\n" +
              'e.g. "/agent-app build a CRM", "/agent-app add a report to my expense app", "/agent-app operate atlas-erp"',
          };
        }
        return { continueAgent: true };
      },
    });

    // A CLI passthrough: `openclaw agent-app …`. A pure passthrough must hand
    // every token to the framework CLIs untouched, so Commander's own option
    // parsing and help are switched off (the same shape OpenClaw's gateway
    // restart-handoff passthrough uses) and the action reads `command.args`:
    // with passThroughOptions, everything after the first operand — flags like
    // `--json` included — stays an operand in its original order.
    api.registerCli(
      ({ program }) => {
        program
          .command("agent-app")
          .description("Run the framework CLIs (build/evolve/operate an Agent App)")
          .helpOption(false)
          .allowUnknownOption()
          .allowExcessArguments()
          .passThroughOptions()
          .action(async (_opts: unknown, command: { args: string[] }) => {
            const args = command.args;
            const r = await runA2App(binFor(args, CLI, FRAMEWORK_CLI), args);
            process.stdout.write(r.stdout);
            if (r.stderr) process.stderr.write(r.stderr);
            if (r.code !== 0) process.exitCode = r.code;
          });
      },
      { descriptors: [{ name: "agent-app", description: "Run the framework CLIs (build/evolve/operate an Agent App)", hasSubcommands: true }] },
    );

    // The entry-point FORM — a read-only page in the Control UI. The frame's
    // auth grant only admits GET/HEAD, so the one route serves the form and,
    // when query parameters carry a submission, re-renders it with the composed
    // kickoff prompt. Nothing mutates; the user carries the prompt into chat.
    api.registerHttpRoute({
      path: ENTRY_ROUTE,
      auth: "gateway",
      match: "prefix",
      async handler(req: HttpReq, res: HttpRes) {
        try {
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("allow", "GET");
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("This surface is read-only: submit through the form's GET navigation or use /agent-app in chat.");
            return;
          }
          const values = Object.fromEntries(new URL(req.url ?? "/", "http://plugin.local").searchParams);
          const apps = await listKnownApps(FRAMEWORK_CLI);
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(agentAppFormHtml({ apps, values, ...(values.action ? { result: buildKickoffPrompt(values) } : {}) }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(String((e as Error)?.message ?? e));
        }
      },
    });

    // Advertise the entry tab so it appears whenever the plugin is enabled.
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "agent-app-home",
      label: "Agent Apps",
      description: "Build, evolve, or operate an Agent App.",
      icon: "layout",
      path: ENTRY_ROUTE,
    });
  },
});

/** The plugin HTTP route that serves the entry form; also the Control UI tab path. */
const ENTRY_ROUTE = "/agent-app/home";

/** Minimal shape of the request/response the OpenClaw HTTP route handler receives
 *  (Node-style). Kept local and loose so the binding does not depend on SDK types
 *  the framework monorepo cannot resolve. */
interface HttpReq {
  method?: string;
  url?: string;
}
interface HttpRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/**
 * Contribute a Control UI tab for a launched app. Call once the app is healthy.
 * OpenClaw renders the tab in a sandboxed frame; `path` is the app's own URL.
 */
export function showAgentApp(
  api: { session: { controls: { registerControlUiDescriptor: (d: Record<string, unknown>) => void } } },
  app: { id: string; name: string; url: string },
): void {
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: `agent-app-${app.id}`,
    label: app.name,
    icon: "layout",
    path: app.url,
  });
}
