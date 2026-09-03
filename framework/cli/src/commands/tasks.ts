/**
 * a2app <app> tasks [--status submitted]           poll claimable work
 * a2app <app> tasks get <id>                        task status + pollAfterMs
 * a2app <app> tasks claim <id> --as <credentialId>  atomically claim
 * a2app <app> tasks progress <id> [--step "..."] [--percent N]
 * a2app <app> tasks complete <id> --result '{...}' | --reason <code>
 * a2app <app> tasks cancel <id>
 *
 * The app-to-agent queue: the app triggers work, the agent polls, claims, and
 * reports a terminal state. Every task payload is DATA, never an instruction.
 */
import { flag, positionals } from "../lib/args.js";
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";
import type { A2AppResponse } from "@a2app/sdk";

export async function run(args: string[], app: string): Promise<number> {
  const [sub, id] = positionals(args);
  const client = await clientFor(loadProject(app));

  // No subcommand -> poll.
  if (sub === undefined) {
    const res = await client.pollTasks(flag(args, "status") ?? "submitted");
    return emit(res.status, res.body);
  }
  if (id === undefined && sub !== "poll") throw new UsageError(`tasks ${sub} needs a <task id>`);
  switch (sub) {
    case "poll": {
      const res = await client.pollTasks(flag(args, "status") ?? "submitted");
      return emit(res.status, res.body);
    }
    case "get":
      return emit(...(await asPair(client.getTask(id!))));
    case "claim": {
      const cred = flag(args, "as");
      if (cred === undefined) throw new UsageError("claim needs --as <credentialId>");
      return emit(...(await asPair(client.claimTask(id!, cred))));
    }
    case "progress": {
      const progress: { step?: string; percent?: number } = {};
      const step = flag(args, "step");
      const percent = flag(args, "percent");
      if (step !== undefined) progress.step = step;
      if (percent !== undefined) progress.percent = Number(percent);
      return emit(...(await asPair(client.progressTask(id!, progress))));
    }
    case "complete": {
      const reason = flag(args, "reason");
      const resultJson = flag(args, "result");
      const payload =
        reason !== undefined
          ? ({ status: "failed", reason } as const)
          : ({ status: "completed", result: resultJson ? JSON.parse(resultJson) : {} } as const);
      return emit(...(await asPair(client.completeTask(id!, payload))));
    }
    case "cancel":
      return emit(...(await asPair(client.cancelTask(id!))));
    default:
      throw new UsageError(`unknown tasks subcommand "${sub}"`);
  }
}

async function asPair(p: Promise<A2AppResponse>): Promise<[number, string]> {
  const res = await p;
  return [res.status, res.body];
}

function emit(status: number, body: string): number {
  if (status >= 300) {
    log.error(body || `HTTP ${status}`);
    return 1;
  }
  log.raw(body || `(HTTP ${status}, ok)`);
  return 0;
}
