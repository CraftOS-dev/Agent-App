/**
 * agent-app skills [--path] [--install <dir>]
 *
 * Hand the framework skills (spec section 5.2) to whoever is asking:
 *
 *   agent-app skills                  list the index (name, activity, description)
 *   agent-app skills --path           print the skills directory and nothing else
 *   agent-app skills --install <dir>  copy the skills into a harness's skills dir
 *
 * The CLI is the enforcement half of the framework and the skills are the
 * knowledge half; without this command a globally-installed binary carries only
 * the first, and an agent on a harness with no plugin has no way to discover
 * that the framework exists at all.
 *
 * Selection stays the agent's job: this command never picks a skill, it only
 * makes them reachable.
 */
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { flag, hasFlag } from "../lib/args.js";
import { UsageError } from "../lib/project.js";
import { findSkillsDir, readSkillsIndex } from "../lib/skills.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = findSkillsDir();
  if (dir === null) {
    log.error("No framework skills found in this build.");
    log.raw(
      JSON.stringify(
        {
          ok: false,
          error: "skills_not_bundled",
          hint: "Set A2APP_SKILLS_DIR, or reinstall with `npm i -g agent-app` (skills are bundled at pack time).",
        },
        null,
        2,
      ),
    );
    return 1;
  }

  if (hasFlag(args, "path")) {
    log.raw(dir);
    return 0;
  }

  const index = readSkillsIndex(dir);

  if (hasFlag(args, "install")) {
    const target = flag(args, "install");
    if (target === undefined || target.startsWith("--")) {
      throw new UsageError('Usage: agent-app skills --install <dir>   (e.g. --install .claude/skills)');
    }
    const dest = resolve(target);
    mkdirSync(dest, { recursive: true });
    // Copy the whole tree, index included: the index is what makes skill
    // selection deterministic, and a harness that ignores it loses nothing.
    // Overwriting is intended — re-running this is how skills get updated.
    cpSync(dir, dest, { recursive: true });
    for (const skill of index.skills) log.step(`installed ${skill.name}`);
    log.ok(`Installed ${index.skills.length} framework skill(s) into ${dest}`);
    log.raw(
      JSON.stringify(
        { ok: true, installed: index.skills.map((s) => s.name), from: dir, into: dest },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const skill of index.skills) {
    log.info(`${skill.activity.padEnd(12)} ${skill.name} — ${skill.description}`);
  }
  log.raw(
    JSON.stringify(
      {
        ok: true,
        dir,
        version: index.version,
        skills: index.skills.map((s) => ({
          name: s.name,
          activity: s.activity,
          description: s.description,
          path: join(dir, s.path),
        })),
      },
      null,
      2,
    ),
  );
  return 0;
}
