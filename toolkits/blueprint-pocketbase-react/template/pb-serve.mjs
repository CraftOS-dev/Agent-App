#!/usr/bin/env node
/**
 * PocketBase launcher (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * `manifest.pipeline.start` is `node pb-serve.mjs`; this is the entry point the
 * framework's `serve` AND `dev` spawn. One launcher, one code path, three
 * redirected inputs from the launch contract:
 *
 *   PORT            the port to bind (`serve` passes manifest.port; `dev` a
 *                   hidden one). Falls back to manifest.port when run by hand.
 *   A2APP_DATA_DIR  the data directory (`serve` passes pb/pb_data; `dev` a
 *                   fresh per-boot directory). Defaults to pb/pb_data.
 *   A2APP_ENV       "live" or "dev". Defaults to "live".
 *
 * It sets one input of its own for PocketBase: A2APP_AUTH_MODE, the manifest's
 * `authMode`, which migrations read to choose a collection's access rules.
 *
 * Environment semantics — "live loads code at boot":
 *   live  hooks are pinned (--hooksWatch=false) and the static View is served
 *         from a SNAPSHOT of pb/pb_public taken at this boot (.a2app/public).
 *         PocketBase serves static files from disk per request, so without the
 *         snapshot a mid-iteration edit to the View would reach live users on
 *         their next refresh — before any gate or verify has seen it.
 *   dev   the tree itself is served: pb/pb_public directly (edit → refresh)
 *         and hooks under watch (auto-restart on edit where the OS supports
 *         it; PocketBase documents no effect on Windows — re-run `dev` there).
 *
 * A superuser is ensured in the target data directory BEFORE serving, from the
 * project-local `.superuser` credential (minted on first use, mode 0600,
 * gitignored). Without one, PocketBase prints an unauthenticated admin-installer
 * URL and pops the setup page — on every fresh dev database, and on the live
 * first serve. Failure to ensure it refuses to serve rather than serving an
 * installable admin takeover.
 *
 * `node pb-serve.mjs --migrate` is the toolkit's `lifecycle.promote`: it applies
 * pending migrations to the data directory and exits. The output is WATCHED,
 * not trusted: PocketBase's `migrate up` can exit 0 on failure and wedge
 * silently on a panic, so a panic line fails the run and a hard timeout bounds
 * it.
 *
 * `node pb-serve.mjs --fetch` is the first half of `pipeline.install`: it puts
 * the pinned PocketBase release for this OS/arch at pb/pocketbase[.exe],
 * checked against the SHA-256s embedded below, and does nothing when that
 * exact binary is already there. An installed app then runs with no manual step.
 *
 * Why a launcher rather than raw commands in the manifest: `serve` spawns the
 * start command through the OS shell, and `pb/pocketbase serve --http
 * 127.0.0.1:${PORT}` is not portable across shells (cmd.exe expands neither
 * `${PORT}` nor `/`-separated executables). Node resolves both.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pbDir = join(here, "pb");

/* ------------------------------------------------------------- the binary */

// The PocketBase release this blueprint is pinned to. The adapter
// (pb/pb_hooks/_a2app*.js) is written against this line's JSVM API, and
// PocketBase has moved its hook, record and DAO APIs between lines before (0.23
// rewrote them), so a binary from another line fails deep inside a hook with an
// opaque ReferenceError. `--fetch` installs exactly the pinned release; serving
// accepts any patch release of its line.
const POCKETBASE_VERSION = "0.39.7";
const SUPPORTED_SERIES = "0.39.";

// SHA-256 of each release zip, copied from the release's checksums.txt
// (https://github.com/pocketbase/pocketbase/releases/tag/v0.39.7). Embedded
// rather than downloaded beside the zip, so a download is held to what this
// hash-locked file says, not to whatever the same server answers. Keyed by the
// release's own `<os>_<arch>` names: an OS/arch missing here is one the release
// does not ship.
const RELEASE_SHA256 = {
  darwin_amd64: "32ee65426529c5fc48b7899431b9cf22e54c40a2f39f9fde92948bcabebaa933",
  darwin_arm64: "f94b96eac1684d35cad5368334c156673fa21ae28df721e712e1cf3b8176aeb8",
  linux_amd64: "0fe09a4e1a8f6e5b53d206c2e6b94a5812febcb43082d66d69bc8ba4d8e8429c",
  linux_arm64: "ff6296e90bb5545592c5696e9d591fa4570fbdf31aaec58b51c70ce7d15f581d",
  linux_armv7: "be8f85b0a6e5bf284e26ca6dca5d88e2ab5234d030274069020566f1b836941c",
  linux_ppc64le: "a643da593e4c234bec4a91039fae4530003f9012137fab181f0d7f1799413301",
  linux_s390x: "5f2dc7cf20d04b548f9f23e124670d97ab4d51ecff1215b391255c268050bed0",
  windows_amd64: "0f32dfda39949cfbec38ea18fe99f1e9e49350ce1efe87537591b44dcee51517",
  windows_arm64: "93ea40181210b1db7d7a885caf832cbd8945ab6ae1d43ed2c858bfc4390b4d26",
};
// SHA-256 of the binary inside each of those zips: what a binary already at
// pb/pocketbase[.exe] must hash to before `--fetch` keeps it. A file is judged by
// its bytes, never by running it — a binary that arrived inside a package would
// otherwise be executed just to ask what version it is, and kept for saying the
// right one.
const BINARY_SHA256 = {
  darwin_amd64: "21a04857ca5ff069ccdd274133b66316b2207226628b531c443683bd1c256af9",
  darwin_arm64: "391caac919eebe71cf85a59183296ce5c9fd00d5e3e2c74be401d231fb282278",
  linux_amd64: "dd6ebcb5a163e36b14454c45382fe8e17974aa9f4ffe3a6e4cca6d8528a26e29",
  linux_arm64: "46aee8dcce801b0cfaa013e640346205ad462c03711820768ee762223aceecd4",
  linux_armv7: "23571695eeb3be36a693fc6db03ccf1ddb92a8ec9f437899236d6196da23343a",
  linux_ppc64le: "862885c8c4b83abb12aa1796381588c9b398fbe20c360e08429e574ac3678d5a",
  linux_s390x: "5d182a1d9747a13b92670da83b2beceb915bece030fda308d8363cd7881f800d",
  windows_amd64: "7072057ce3b5d2c94f91d203b11d5e4cbc0603e6a0f6ef411b99f06d44af3595",
  windows_arm64: "785d1bee66a29459f90a8a7ed2bd0a119eae801805f80f4ca636803fdfb88a36",
};
/** A release zip is ~13 MB; anything far larger is not the release. */
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// PocketBase ships as `pocketbase` on POSIX and `pocketbase.exe` on Windows;
// both live in `pb/` (put there by `--fetch`, the pipeline's `install`).
const binary = join(pbDir, process.platform === "win32" ? "pocketbase.exe" : "pocketbase");

/** The version a PocketBase binary reports, or null when there is none or it
 *  does not run here. `pocketbase --version` prints "pocketbase[.exe] version
 *  0.39.7"; the version is the last token. */
function versionOf(file) {
  if (!existsSync(file)) return null;
  try {
    return execFileSync(file, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim().split(" ").pop();
  } catch {
    return null;
  }
}

/** This machine as the release names its builds (`windows_amd64`, …), or null
 *  when the release ships no build for it. */
function releaseTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64", arm: "armv7", ppc64: "ppc64le", s390x: "s390x" }[process.arch];
  const target = `${os}_${arch}`;
  return Object.hasOwn(RELEASE_SHA256, target) ? target : null;
}

/** The SHA-256 of a file, or null when there is none. */
function sha256Of(file) {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

/**
 * `--fetch`: download the pinned release for this OS/arch, refuse it unless its
 * SHA-256 is the embedded one, and put only the binary at pb/pocketbase[.exe],
 * executable. Nothing happens when that exact binary is already there.
 */
async function fetchBinary() {
  const target = releaseTarget();
  if (target !== null && sha256Of(binary) === BINARY_SHA256[target]) {
    console.log(`PocketBase ${POCKETBASE_VERSION} (${target}, SHA-256 verified) is already at ${binary}`);
    return;
  }
  if (target === null) {
    // No release to check against: a binary here is one this machine's owner
    // built and placed by hand, as the error below asks.
    if (versionOf(binary) === POCKETBASE_VERSION) {
      console.log(`PocketBase ${POCKETBASE_VERSION} (built for this machine) is at ${binary}`);
      return;
    }
    throw new Error(
      `PocketBase ${POCKETBASE_VERSION} ships no build for ${process.platform}/${process.arch} ` +
        `(its release has ${Object.keys(RELEASE_SHA256).join(", ")}). Build v${POCKETBASE_VERSION} for this machine ` +
        `from https://github.com/pocketbase/pocketbase and place it at ${binary}.`,
    );
  }
  const asset = `pocketbase_${POCKETBASE_VERSION}_${target}.zip`;
  const url = `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${asset}`;
  console.log(`downloading ${url}`);
  const zip = await download(url);
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== RELEASE_SHA256[target]) {
    throw new Error(`${asset} is not the pinned release: its SHA-256 is ${digest}, not ${RELEASE_SHA256[target]}. Nothing was installed.`);
  }

  // Written beside the binary and checked to run before it takes the binary's
  // place, so a failed fetch never leaves a broken file where serve looks.
  const extracted = zipEntry(zip, basename(binary));
  if (createHash("sha256").update(extracted).digest("hex") !== BINARY_SHA256[target]) {
    throw new Error(`the binary in ${asset} is not the pinned one. Nothing was installed.`);
  }
  const partial = `${binary}.partial`;
  mkdirSync(pbDir, { recursive: true });
  try {
    writeFileSync(partial, extracted);
    chmodSync(partial, 0o755);
    const got = versionOf(partial);
    if (got !== POCKETBASE_VERSION) {
      throw new Error(`the binary in ${asset} does not run on this machine (it reported ${got ?? "nothing"}).`);
    }
    renameSync(partial, binary);
  } catch (err) {
    rmSync(partial, { force: true });
    if (err.code === "EPERM" || err.code === "EBUSY") {
      throw new Error(`could not replace ${binary} (${err.code}): stop the app that is running it, then fetch again.`);
    }
    throw err;
  }
  console.log(`PocketBase ${POCKETBASE_VERSION} (${target}, SHA-256 verified) is at ${binary}`);
}

/** The body at `url`, following GitHub's redirect to its download host; bounded
 *  in size and time. */
async function download(url) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`could not download ${url}: ${err.cause?.message ?? err.message}`);
  }
  if (!res.ok || !res.body) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error(`${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes; refusing it.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * One file from a zip archive, by its name at the archive's root. This reads
 * as much of the format as a release zip uses — stored or deflated entries,
 * found through the central directory — and refuses the rest (encryption,
 * zip64) by name. The archive's SHA-256 is verified before this runs.
 */
function zipEntry(zip, name) {
  const END = 0x06054b50; // end of central directory
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff) && end < 0; i--) {
    if (zip.readUInt32LE(i) === END) end = i;
  }
  if (end < 0) throw new Error("the download is not a zip archive.");
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error("the zip archive's directory is damaged.");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (entry !== name) continue;
    if (flags & 1) throw new Error(`${name} is encrypted in the archive.`);
    if ([packed, size, local].includes(0xffffffff)) throw new Error(`${name} is a zip64 entry, which this launcher does not read.`);
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error("the zip archive's entry header is damaged.");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    if (method !== 0 && method !== 8) throw new Error(`${name} uses zip compression method ${method}, which this launcher does not read.`);
    const out = method === 8 ? inflateRawSync(data) : data;
    if (out.length !== size) throw new Error(`${name} did not extract to its recorded size.`);
    return out;
  }
  throw new Error(`the archive has no ${name} at its root.`);
}

if (process.argv.includes("--fetch")) {
  try {
    await fetchBinary();
    process.exit(0);
  } catch (err) {
    console.error(`could not fetch PocketBase: ${err.message}`);
    process.exit(1);
  }
}

/* -------------------------------------------------------------- the launch */

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const port = process.env.PORT ?? manifest.port;

// The app's mode, for its migrations: a collection's access rules depend on it
// (public on a single-user app, per signed-in person on a multi-user one — see
// the starter's tasks migration). Migrations run inside PocketBase, in both
// `migrate up` and `serve`, so the mode reaches them through the environment
// every PocketBase process this launcher starts inherits.
process.env.A2APP_AUTH_MODE = manifest.authMode === "multi-user" ? "multi-user" : "none";
const env = process.env.A2APP_ENV ?? "live";
const dataDir = process.env.A2APP_DATA_DIR ?? join(pbDir, "pb_data");
const hooksDir = join(pbDir, "pb_hooks");
const migrationsDir = join(pbDir, "pb_migrations");
const publicSrc = join(pbDir, "pb_public");

const migrateMode = process.argv.includes("--migrate");

/**
 * Where to listen (A2APP_HOST, default loopback) and the address people and
 * agents use (A2APP_PUBLIC_URL). The same rule every Agent App adapter applies:
 * a bearer token must never cross a network in clear, so a non-loopback bind
 * needs an https public URL, and a public URL may be plain http only when it
 * names this machine (an SSH tunnel). The hooks read the normalized origin
 * back from the environment PocketBase inherits.
 */
function isLoopbackName(name) {
  const n = name.toLowerCase();
  return n === "localhost" || n === "::1" || n === "[::1]" || (isIPv4(n) && n.split(".")[0] === "127");
}
function networkPolicy() {
  const host = process.env.A2APP_HOST?.trim() || "127.0.0.1";
  const raw = process.env.A2APP_PUBLIC_URL?.trim();
  let pub = null;
  if (raw) {
    try {
      pub = new URL(raw);
    } catch {
      throw new Error(`A2APP_PUBLIC_URL is not a URL: "${raw}".`);
    }
    if (pub.protocol !== "https:" && pub.protocol !== "http:") throw new Error(`A2APP_PUBLIC_URL must be an http(s) URL, not "${raw}".`);
    if (pub.protocol === "http:" && !isLoopbackName(pub.hostname)) {
      throw new Error(
        `A2APP_PUBLIC_URL must be https: "${raw}" would send the agent token across a network in clear. ` +
          `Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address.`,
      );
    }
  }
  if (!isLoopbackName(host) && pub?.protocol !== "https:") {
    throw new Error(
      `A2APP_HOST=${host} exposes the app to the network, so A2APP_PUBLIC_URL must name its https address ` +
        `(the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1.`,
    );
  }
  return { host, publicUrl: pub ? pub.origin : null };
}
// `--migrate` binds nothing, so only a serving launch is held to it.
let network = { host: "127.0.0.1", publicUrl: null };
if (!migrateMode) {
  try {
    network = networkPolicy();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
if (network.publicUrl) process.env.A2APP_PUBLIC_URL = network.publicUrl;
else delete process.env.A2APP_PUBLIC_URL;
if (!migrateMode && !port) {
  console.error("no port to bind: set PORT in the environment or `port` in manifest.json");
  process.exit(1);
}

// The binary must be there, run, and be on the supported series.
if (!existsSync(binary)) {
  console.error(`PocketBase binary not found at ${binary}: run \`node pb-serve.mjs --fetch\` (the pipeline's \`install\`) before serving`);
  process.exit(1);
}
const version = versionOf(binary);
if (version === null) {
  console.error(`PocketBase at ${binary} does not run on this machine: run \`node pb-serve.mjs --fetch\` to replace it`);
  process.exit(1);
}
if (!version.startsWith(SUPPORTED_SERIES)) {
  console.error(
    `PocketBase ${version} is not supported: this app's adapter targets the ${SUPPORTED_SERIES}x JSVM API. ` +
      `Run \`node pb-serve.mjs --fetch\` to replace ${binary} with the pinned v${POCKETBASE_VERSION}.`,
  );
  process.exit(1);
}

// PocketBase resolves these relative to the binary when unset; passing them
// explicitly means the launcher — not the binary's location — defines the
// layout. The migrations dir must exist (a scaffolded app has none yet).
mkdirSync(migrationsDir, { recursive: true });

/** Recursive copy without fs.cpSync — cpSync silently crashes on Windows when
 *  the source path contains non-ASCII characters (exit 0xC0000409, no JS error;
 *  the framework's own fsx.ts documents the same finding). */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

/**
 * Watched PocketBase invocation for migrations. `migrate up` is not trusted to
 * report its own failure: it can exit 0 after an error and wedge on a recovered
 * panic. A panic line fails the run; a hard timeout bounds it.
 */
function runMigrate() {
  const child = spawn(binary, ["migrate", "up", "--dir", dataDir, "--migrationsDir", migrationsDir, "--hooksDir", hooksDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let sawPanic = false;
  const watch = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    if (/panic|RECOVERED FROM PANIC/i.test(text)) {
      sawPanic = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  const timeout = setTimeout(() => {
    console.error("migrate up exceeded 120s — killing it. A wedged migration usually means a panic inside a migration file.");
    sawPanic = true;
    child.kill("SIGKILL");
  }, 120_000);
  child.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`failed to run migrate: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (sawPanic) {
      console.error("migration FAILED (panic or timeout — see output above). The live database was left as the migration engine left it; the pre-promote backup is the way back.");
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (migrateMode) {
  runMigrate();
} else {
  // Ensure a superuser exists in the TARGET data directory before serving.
  // The command bootstraps the database if the directory is empty — which, for
  // a dev boot, is also what replays the full migration chain into it.
  const superuserFile = join(here, ".superuser");
  let creds = null;
  if (existsSync(superuserFile)) {
    try {
      const parsed = JSON.parse(readFileSync(superuserFile, "utf8"));
      if (typeof parsed.email === "string" && typeof parsed.password === "string") creds = parsed;
    } catch {
      /* unreadable — refuse below rather than silently minting a second credential */
    }
    if (creds === null) {
      console.error(`${superuserFile} exists but is not readable JSON {email, password} — fix or delete it`);
      process.exit(1);
    }
  } else {
    creds = { email: "agent@a2app.local", password: randomBytes(24).toString("base64url") };
  }
  try {
    execFileSync(binary, ["superuser", "upsert", creds.email, creds.password, "--dir", dataDir, "--migrationsDir", migrationsDir, "--hooksDir", hooksDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    // Fail closed: serving without a superuser makes PocketBase print an
    // unauthenticated admin-installer link and open the setup page.
    console.error(`could not ensure a superuser in ${dataDir} — refusing to serve.`);
    console.error(String(err.stdout ?? "") + String(err.stderr ?? "") || err.message);
    process.exit(1);
  }
  if (!existsSync(superuserFile)) {
    writeFileSync(superuserFile, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  }

  // The View: live serves a boot-time snapshot; dev serves the tree.
  let publicDir = publicSrc;
  if (env === "live" && existsSync(publicSrc)) {
    const snapshot = join(here, ".a2app", "public");
    rmSync(snapshot, { recursive: true, force: true });
    copyDir(publicSrc, snapshot);
    publicDir = snapshot;
  }

  const child = spawn(
    binary,
    [
      "serve",
      "--http",
      `${isIPv6(network.host) ? `[${network.host}]` : network.host}:${port}`,
      "--dir",
      dataDir,
      "--hooksDir",
      hooksDir,
      "--migrationsDir",
      migrationsDir,
      "--publicDir",
      publicDir,
      // PocketBase answers CORS for every origin by default; only the app's own
      // View should be able to read a response. The hooks also refuse a foreign
      // Origin outright — this keeps the browser from even seeing the answer.
      `--origins=${[`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(network.publicUrl ? [network.publicUrl] : [])].join(",")}`,
      // The access middleware in pb/pb_hooks wraps every request, so each open
      // realtime connection holds a hook runtime for its whole life. The
      // default pool is 15; past it PocketBase builds a throwaway runtime per
      // request. 40 leaves room for a View that subscribes in several tabs.
      "--hooksPool=40",
      // Live must never hot-load an unverified edit; dev wants exactly that.
      `--hooksWatch=${env === "dev"}`,
    ],
    { stdio: "inherit" },
  );

  // Forward termination so a direct SIGINT/SIGTERM reaches PocketBase; `serve`/
  // `stop` signal the whole process tree, but a launcher stopped on its own must
  // not orphan the child.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

  child.on("error", (err) => {
    console.error(`failed to launch PocketBase: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
