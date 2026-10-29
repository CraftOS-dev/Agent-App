/**
 * Downloads for the marketplace and GitHub sources (framework packaging §2).
 *
 * Every download is bounded three ways, each enforced while bytes arrive rather
 * than after:
 *  - a deadline for the whole transfer;
 *  - a size cap: a declared Content-Length over it is refused before the body is
 *    read, and a body that runs past it is cut off at the byte that crossed it;
 *  - redirects are followed by fetch itself (GitHub serves branch archives from
 *    codeload through one).
 *
 * The SHA-256 is computed in the same pass, so the hash recorded with an app is
 * the hash of exactly the bytes that were read.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { VERSION } from "../cli.js";
import { formatBytes, PackageRefusedError, SourceNotFoundError, SourceUnreachableError } from "./packageErrors.js";

export const USER_AGENT = `agent-app/${VERSION} (+https://github.com/CraftOS-dev/Agent-App)`;

export interface DownloadLimits {
  /** refuse a body larger than this */
  maxBytes: number;
  /** abort the whole transfer after this long */
  timeoutMs: number;
}

export interface Downloaded {
  bytes: number;
  sha256: string;
}

/**
 * Stream `url`'s body to `onChunk`, enforcing the limits. Errors are sorted by
 * what they mean: 404/410 → SourceNotFoundError; any other failure to get an
 * answer (DNS, refused, reset, timeout, 5xx, rate limiting) →
 * SourceUnreachableError; a body over the cap → PackageRefusedError.
 */
async function stream(url: string, limits: DownloadLimits, onChunk: (chunk: Uint8Array) => void): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  let received = 0;
  try {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", headers: { "user-agent": USER_AGENT }, signal: controller.signal });
    } catch (err) {
      throw unreachable(url, err, controller.signal.aborted, limits.timeoutMs);
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel();
      throw new SourceNotFoundError(`${url} answered ${res.status}: not found`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SourceUnreachableError(`${url} answered ${res.status} ${res.statusText}`.trim());
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await res.body?.cancel();
      throw new PackageRefusedError(`${url} is ${formatBytes(declared)}, over the ${formatBytes(limits.maxBytes)} limit`);
    }
    if (res.body === null) return 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > limits.maxBytes) {
          controller.abort();
          throw new PackageRefusedError(`${url} runs past the ${formatBytes(limits.maxBytes)} limit`);
        }
        onChunk(value);
      }
    } catch (err) {
      if (err instanceof PackageRefusedError) throw err;
      throw unreachable(url, err, controller.signal.aborted, limits.timeoutMs);
    }
    return received;
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(url: string, err: unknown, timedOut: boolean, timeoutMs: number): SourceUnreachableError {
  if (timedOut) return new SourceUnreachableError(`${url} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  const cause = (err as { cause?: { message?: string; code?: string } }).cause;
  const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  return new SourceUnreachableError(`${url} is unreachable (${detail})`);
}

/** Download `url` into a new file (removed again on any failure). */
export async function downloadToFile(url: string, file: string, limits: DownloadLimits): Promise<Downloaded> {
  const hash = createHash("sha256");
  const fd = openSync(file, "wx");
  let complete = false;
  try {
    const bytes = await stream(url, limits, (chunk) => {
      let done = 0;
      while (done < chunk.length) done += writeSync(fd, chunk, done, chunk.length - done);
      hash.update(chunk);
    });
    complete = true;
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
    if (!complete) rmSync(file, { force: true });
  }
}

/** Download a small document (a catalogue) into memory. */
export async function downloadBytes(url: string, limits: DownloadLimits): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await stream(url, limits, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}
