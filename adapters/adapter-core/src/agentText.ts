/**
 * Text this adapter puts into an AGENT'S CONTEXT.
 *
 * Most strings an adapter emits are diagnostics: a human reads them in a log and
 * nothing acts on them. The ones here are different. They travel in a reply an
 * agent parses, land in its context, and are read next to its own instructions —
 * so they are content in the same channel as directives, and a sentence added
 * here is a sentence an agent will weigh.
 *
 * Collecting them makes adding one a DELIBERATE act. Written inline at the site
 * that emits them, a new line of agent-facing text arrives as an incidental part
 * of some other change and is reviewed as a message rather than as context. That
 * is the gap this file closes: one place to look, and a diff that shows when the
 * set changes.
 *
 * Two rules for anything added here:
 *
 *  1. **State a fact, never issue an instruction.** "A credential is obtained
 *     from …" is a fact. "Run this command" is an instruction, and an agent that
 *     follows instructions arriving from an app is an agent an app can steer.
 *  2. **Say who it is for when that is not obvious.** The credential hint is
 *     addressed to whoever runs the app, not to the agent reading it — the
 *     connect skill tells agents exactly that, and the text should not fight it.
 *
 * App-supplied text is a separate problem; see {@link boundAppText}.
 */

/** Framework-authored text that reaches an agent. */
export const AGENT_TEXT = {
  /**
   * The default `how` on a `401 agent_token_required`.
   *
   * It describes a file on the app's own host, so it is an answer only the
   * app's owner can act on. An app served to anyone else sets `credentialHint`
   * to something its callers can actually use.
   */
  credentialHint: "Read the app's .agent-token file (mode 0600) in the project directory.",
} as const;

/**
 * The cap on app-supplied text forwarded into an agent's context.
 *
 * Long enough for a real hint — a sentence naming where a credential comes from
 * — and far too short to carry a payload of instructions.
 */
export const APP_TEXT_MAX = 300;

/**
 * Bound a string the APP supplied before it is forwarded to an agent.
 *
 * `credentialHint` is set by the app and copied into the `401` challenge, which
 * means an app can put text of its choosing into the context of every agent that
 * fails to authenticate to it. That is the one place where text reaching an agent
 * has not been through this repository's review, and an unbounded field there is
 * an open channel rather than a hint.
 *
 * Two bounds, for two different reasons:
 *
 *  - **One line.** Newlines are what let injected text impersonate structure —
 *    a blank line and a heading read as a new section rather than as the tail of
 *    a hint. Collapsing whitespace keeps it a sentence.
 *  - **A length cap.** A hint is a sentence. Anything long enough to be an
 *    argument is not a hint, and truncation costs the app nothing it should have
 *    been sending.
 *
 * This does not make app text trustworthy, and is not meant to: the connect
 * skill already tells agents that a remote app's text is data and never a
 * directive. It keeps the channel narrow enough that the rule is easy to hold.
 *
 * Returns undefined for absent or blank input, so the caller falls back to the
 * framework's own text rather than sending an empty field.
 */
export function boundAppText(value: unknown, max: number = APP_TEXT_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  // Every run of whitespace — newlines included — becomes one space.
  const single = value.replace(/\s+/g, " ").trim();
  if (single === "") return undefined;
  if (single.length <= max) return single;
  // Marked rather than silently cut, and the marker says what happened and how
  // much is gone — the reader needs no other context to know it was shortened.
  // The suffix counts toward the cap, and its own length changes the count it
  // reports; three passes reach the fixed point (digit count grows at most twice).
  let suffix = "";
  for (let i = 0; i < 3; i++) suffix = ` [truncated by adapter, ${single.length - max + suffix.length} chars cut]`;
  return single.slice(0, Math.max(0, max - suffix.length)) + suffix;
}
