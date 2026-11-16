/**
 * agent-app <dir> commit --message "<what changed and why>"
 *
 * Commit the app's changes to its history (Quality Standard Q18): everything
 * under the app its ignore rules do not exclude, as one commit. This is how an
 * agent keeps the history without a shell of its own, and what walk-verify
 * verifies — commit each coherent change as it is made, and always before a
 * verification.
 *
 * An app with no repository yet (one created before the framework kept its
 * history) gets one of its own here. Credentials, the database and runtime
 * state never reach a commit: the ignore rules that exclude them are written
 * first wherever they are missing.
 */
import { parseFlags } from "../lib/args.js";
import { log } from "../lib/log.js";
import { loadProject, UsageError } from "../lib/project.js";
import { commitApp, createRepository, workTree } from "../lib/repo.js";
import { ensureIgnoreRules } from "../lib/scaffoldFiles.js";
import { projectToolkit } from "../lib/toolkit.js";

export async function run(args: string[], app: string): Promise<number> {
  const flags = parseFlags(args, { values: ["message"] });
  if (flags.positionals.length > 0) throw new UsageError(`commit takes only --message (got ${flags.positionals.join(" ")})`);
  const message = flags.values.get("message")?.trim() ?? "";
  if (message === "") throw new UsageError('commit needs --message "<what changed and why>"');

  const project = loadProject(app);
  ensureIgnoreRules(project.dir, projectToolkit(project.dir)?.manifest.lifecycle?.dataDir);
  const created = workTree(project.dir) === null;
  if (created) {
    createRepository(project.dir);
    log.step("created the app's repository");
  }

  const result = commitApp(project.dir, message);
  if (result.committed) log.ok(`committed ${result.commit!.slice(0, 12)} — ${result.files.length} file(s): ${message}`);
  else log.info(`nothing to commit — ${result.commit !== null ? `${result.commit.slice(0, 12)} already holds the app as it stands` : "the app has no files to commit"}`);
  log.raw(JSON.stringify({ ok: true, ...result, ...(created ? { created } : {}) }, null, 2));
  return 0;
}
