/**
 * Plays the person's browser for login.test.mjs, as the CLI's opener
 * (AGENT_APP_OPEN_CMD): opens the approval link signed in as the person
 * (FAKE_BROWSER_COOKIE), approves, and follows the page's redirect — the only
 * way the confirmation code reaches the CLI waiting on its loopback port.
 */
const link = new URL(process.argv[2]);
const code = link.hash.split("/")[1];
const headers = { "content-type": "application/json", origin: link.origin, cookie: process.env.FAKE_BROWSER_COOKIE };
const res = await fetch(`${link.origin}/api/_a2app/auth/device/${code}`, { method: "POST", headers, body: JSON.stringify({ approve: true }) });
await fetch((await res.json()).redirect);
// Idle keep-alive sockets would otherwise hold this process open for seconds.
process.exit(0);
