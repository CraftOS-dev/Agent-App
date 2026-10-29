/**
 * Running the framework CLIs (`agent-app` and `a2app`) and reading their
 * result: the one place this engine starts a process.
 */
// cross-spawn instead of node:child_process spawn: npm installs CLIs as .cmd
// shims on Windows, which plain spawn cannot execute; cross-spawn runs them
// while still passing argv literally (no shell interpretation of field values).
import spawn from "cross-spawn";

/** The result of one framework CLI invocation (`agent-app` or `a2app`). `json` is populated when stdout is a
 *  JSON document; `ok` mirrors exit code 0. */
export interface CliResult {
  code: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  json: unknown;
}

export interface RunOptions {
  /** called with each complete stdout line as the CLI writes it (for `install --events`) */
  onLine?: (line: string) => void;
}

/**
 * Run one of the framework CLIs and resolve a structured result. Never uses a shell (field
 * values reach the CLI as literal argv, so a value like `x & rm -rf` cannot be
 * interpreted). If `cliBin` points at a JS entry (`…/cli.js`), it is run with
 * the current Node executable; otherwise it is spawned directly (PATH-resolved).
 */
export function runA2App(cliBin: string, argv: string[], opts: RunOptions = {}): Promise<CliResult> {
  const isNodeEntry = /\.[mc]?js$/.test(cliBin);
  const command = isNodeEntry ? process.execPath : cliBin;
  const args = isNodeEntry ? [cliBin, ...argv] : argv;
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const onLine = opts.onLine;
    // stdio is ["ignore", "pipe", "pipe"], so both streams exist; cross-spawn's
    // types lack node's per-stdio-config narrowing.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      stdout += d;
      if (onLine === undefined) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr!.on("data", (d: string) => (stderr += d));
    child.on("close", (code) => {
      if (onLine !== undefined && pending !== "") onLine(pending);
      resolve(finish(code ?? -1, stdout, stderr));
    });
    child.on("error", (e) => resolve(finish(-1, "", String((e as Error).message))));
  });
}

function finish(code: number, stdout: string, stderr: string): CliResult {
  let json: unknown = null;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  return { code, ok: code === 0, stdout, stderr, json };
}
