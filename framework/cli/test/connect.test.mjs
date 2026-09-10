/**
 * Connect: addressing an app that is not on this machine.
 *
 * Standard library only, run directly, so `pnpm -r test` needs no test runner.
 *
 * Two things are being pinned down here, and they fail in opposite directions.
 *
 * The BOUNDARY: `a2app` operates, `agent-app` builds. A remote app has no files
 * here, so every build and lifecycle command must refuse a URL — and refuse it
 * by saying what can be done instead, because an agent told only "no" will look
 * for another way in. That refusal lives in `loadProject`, which is the one
 * function all of those commands go through.
 *
 * The GATE: what answers a URL is not established by the URL answering. An
 * origin that stops being the app it was is the failure that matters, because it
 * looks exactly like success — the requests still work, against something else.
 * So identity is verified before a client is handed out, and the id an origin
 * first returned is the id it is held to.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => {
  if (!cond) failures.push(label);
};

/** Run `fn` with A2APP_HOME pointed at a throwaway directory. */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "a2app-home-"));
  const previous = process.env.A2APP_HOME;
  process.env.A2APP_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.A2APP_HOME;
    else process.env.A2APP_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A server that serves whatever identity document it is currently holding. */
async function withApp(identity, fn) {
  let doc = identity;
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/a2app.json" || req.url === "/api/_a2app") {
      if (doc === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not here" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(doc));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, (next) => {
      doc = next;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const identityFor = (id, protocol = "0.1", name = "Test App") => ({
  a2app: true,
  protocol,
  adapterVersion: "0.0.1",
  app: { id, name },
  schemaVersion: "sv1",
  serverNow: new Date().toISOString(),
  serverTzOffsetMinutes: 0,
});

/** The error a call throws, or null when it does not throw. */
async function thrown(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

const { isRemoteAddress, loadProject } = await import("../dist/lib/project.js");
const { cacheDirFor, clientForTarget, labelFor, resolveTarget } = await import("../dist/lib/target.js");
const { credentialFor, knownAppsPath, originOf, pinnedAppId } = await import("../dist/lib/remote.js");

/* --------------------------------------------------- addressing an app */

check("http is a remote address", isRemoteAddress("http://x.example"), true);
check("https is a remote address", isRemoteAddress("https://x.example"), true);
check("a relative directory is not", isRemoteAddress("./my-app"), false);
check("an absolute path is not", isRemoteAddress("/srv/my-app"), false);
check("a registered name is not", isRemoteAddress("Kanban Board"), false);
// A Windows path starts with a drive letter and a colon, which a careless URL
// test reads as a scheme. It is a directory, and must stay one.
check("a Windows path is not a URL", isRemoteAddress("C:\\Users\\me\\app"), false);

// A scheme that is neither http nor https is refused rather than being read as a
// directory name, so a mistyped address says what is wrong with it.
const fileScheme = await thrown(() => isRemoteAddress("file:///etc/passwd"));
ok("file:// is refused, not treated as a path", fileScheme !== null);
ok(
  "the refusal names the addressing forms that work",
  fileScheme !== null && /directory.*registered id\/name.*http\(s\) URL/s.test(fileScheme.message),
);

/* ------------------------------------------- the operate/modify boundary */

const asProject = await thrown(() => loadProject("https://app.example.com"));
ok("loadProject refuses a URL", asProject !== null);
ok(
  "the refusal says the app can be operated",
  asProject !== null && /operated, not modified/.test(asProject.message),
);
ok(
  "the refusal names the command that works",
  asProject !== null && /a2app https:\/\/app\.example\.com/.test(asProject.message),
);

/* ------------------------------------------------------ target resolution */

await withHome(async () => {
  const t = resolveTarget("https://app.example.com/");
  check("a URL resolves to a remote target", t.kind, "remote");
  check("a trailing slash is not part of the base URL", t.baseUrl, "https://app.example.com");
  check("the origin is the key", t.origin, "https://app.example.com");
  check("nothing is pinned on first sight", t.expectedAppId, null);
  check("a path does not change the origin", originOf("https://app.example.com/deep/path"), "https://app.example.com");

  // Two origins must not share a cache directory, and neither may escape home.
  const a = cacheDirFor(resolveTarget("https://one.example.com"));
  const b = cacheDirFor(resolveTarget("https://two.example.com"));
  ok("two origins get different cache directories", a !== b);
  ok("a remote cache lives under the framework home", a.startsWith(process.env.A2APP_HOME));
  // The slug is built from an attacker-influenced string (whatever host the
  // agent was pointed at), so it must not be able to carry a path out of home.
  const slug = basename(a);
  ok("the slug has no separators", !/[\\/]/.test(slug));
  ok("the slug cannot traverse upward", !slug.includes(".."));
  check(
    "a host that looks like a path is flattened",
    basename(cacheDirFor(resolveTarget("https://evil.example.com"))),
    "https-evil-example-com",
  );
});

/* ------------------------------------------------------------ credentials */

await withHome(async (home) => {
  const origin = "https://app.example.com";
  check("no credential when there is no store", credentialFor(origin, null).token, null);

  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({
      version: 1,
      credentials: [
        { origin, token: "bare-origin-token" },
        { origin, appId: "specific", token: "app-specific-token" },
        { origin: "https://other.example.com", token: "wrong-origin" },
      ],
    }),
  );

  check("a bare origin entry is found", credentialFor(origin, null).token, "bare-origin-token");
  check("an appId entry wins over a bare one", credentialFor(origin, "specific").token, "app-specific-token");
  check("an unrelated origin is never used", credentialFor("https://nope.example.com", null).token, null);
  check(
    "an unknown appId falls back to the bare origin entry",
    credentialFor(origin, "unknown").token,
    "bare-origin-token",
  );

  // The environment is how a harness hands an agent one app for one run, so it
  // has to beat whatever the machine happens to remember.
  process.env.A2APP_TOKEN = "env-token";
  check("A2APP_TOKEN wins over the store", credentialFor(origin, "specific").token, "env-token");
  delete process.env.A2APP_TOKEN;
  check("removing it falls back to the store", credentialFor(origin, "specific").token, "app-specific-token");
});

/* ------------------------------------------------- the identity gate */

// A healthy app: verified, pinned, and usable.
await withHome(async () => {
  await withApp(identityFor("kanban"), async (base) => {
    const target = resolveTarget(base);
    const client = await clientForTarget(target);
    ok("a verified app yields a client", client !== null);
    check("the app id is recorded on the target", target.appId, "kanban");
    check("the label prefers the app's own name", labelFor(target), "Test App");
    check("first contact pins the id", pinnedAppId(originOf(base)), "kanban");

    // Reaching it again must not re-pin; it must check against the pin.
    const again = resolveTarget(base);
    check("a second visit carries the pin", again.expectedAppId, "kanban");
    await clientForTarget(again);
    check("the pin is unchanged", pinnedAppId(originOf(base)), "kanban");
  });
});

// The failure that matters: the origin still answers, as something else.
await withHome(async () => {
  await withApp(identityFor("kanban"), async (base, serve) => {
    await clientForTarget(resolveTarget(base));
    serve(identityFor("not-kanban"));
    const err = await thrown(() => clientForTarget(resolveTarget(base)));
    ok("a changed app.id is refused", err !== null);
    ok("the refusal names both ids", err !== null && /"not-kanban".*"kanban"/s.test(err.message));
    check("the pin is not overwritten by the impostor", pinnedAppId(originOf(base)), "kanban");
  });
});

// Not an Agent App at all.
await withHome(async () => {
  await withApp(null, async (base) => {
    const err = await thrown(() => clientForTarget(resolveTarget(base)));
    ok("a server with no identity document is refused", err !== null);
    ok("the refusal says what was missing", err !== null && /a2app: true/.test(err.message));
    check("nothing is pinned for a non-app", pinnedAppId(originOf(base)), null);
  });
});

// A protocol this client does not speak: read nothing, write nothing.
await withHome(async () => {
  await withApp(identityFor("future", "0.2"), async (base) => {
    const err = await thrown(() => clientForTarget(resolveTarget(base)));
    ok("an unrecognised protocol is refused", err !== null);
    ok("the refusal names the version", err !== null && /"0\.2"/.test(err.message));
    check("nothing is pinned for an unusable protocol", pinnedAppId(originOf(base)), null);
  });
});

// An identity document with the marker but no id is not enough to act on.
await withHome(async () => {
  const noId = { ...identityFor("x"), app: { name: "Nameless" } };
  await withApp(noId, async (base) => {
    const err = await thrown(() => clientForTarget(resolveTarget(base)));
    ok("an identity with no app.id is refused", err !== null);
    ok("the refusal says what was missing", err !== null && /app\.id/.test(err.message));
  });
});

// The pin survives as a file, so a later process sees the same expectation.
await withHome(async () => {
  await withApp(identityFor("durable"), async (base) => {
    await clientForTarget(resolveTarget(base));
    const stored = JSON.parse(readFileSync(knownAppsPath(), "utf8"));
    check("the pin is written to the known-apps file", stored.apps.length, 1);
    check("it records the app id", stored.apps[0].appId, "durable");
    check("it records the origin", stored.apps[0].origin, originOf(base));
    ok("it records when it was first seen", typeof stored.apps[0].firstSeen === "string");
  });
});

/* ---------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`connect: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("connect: all checks passed");
