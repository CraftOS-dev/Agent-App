/**
 * Global conventions (framework section 5.7): `GLOBAL_AGENT_APP.md` in the
 * framework home — the rules a user wants EVERY app they own to follow, stated
 * once instead of repeated per app.
 *
 * Seeded on first use, then owned by the user: the framework never overwrites
 * it. Per-app requirements override it on conflict. It carries no brand, no
 * palette and no stack — a shipped default colour would be one host's identity
 * leaking into every app the framework builds.
 */
import { existsSync, readFileSync } from "node:fs";
import { ensureHome, GLOBAL_DOC_FILE, homePath, writeFileAtomic } from "./home.js";

export function globalDocPath(): string {
  return homePath(GLOBAL_DOC_FILE);
}

const TEMPLATE = `# Global Agent App Conventions

Rules applied to EVERY Agent App you own. An individual app's
\`reference/requirements.md\` overrides anything here when the two conflict —
this file is the default, not the law.

Edit freely: it is yours. The framework seeds it once and never rewrites it.

## Design preferences

State cross-app look and feel here. Left blank on purpose: the framework ships
no brand, palette, or font, because your apps are yours and theming belongs to
whatever displays them.

- **Theme mode:** follow the system (light/dark)
- **Colour:** (unset — name your palette here, or leave it to the display)
- **Font:** system default
- **Density:** comfortable

## Always enforced

Quality rules every app must satisfy, whatever the stack:

- Empty states say what the thing is and offer the action that fills it.
- Every async action shows a loading state; nothing looks frozen.
- Destructive actions confirm first, and say what will be lost.
- Every write reports its outcome from what was stored, never from what was sent.
- Errors surface to the user in plain language, with the next step.
- Forms validate inline and explain how to fix the value.
- Text meets accessible contrast against its background, in both theme modes.
- The layout works at small widths; nothing is unreachable on a narrow screen.
- Interactive elements show hover/focus states and are keyboard reachable.

## Optional rules

Opt in by ticking. An agent reads these as requirements when ticked.

- [ ] Search/filter on every list view
- [ ] Item counts on sections and categories
- [ ] Drag-and-drop reordering where order is meaningful
- [ ] Keyboard shortcuts for frequent actions
- [ ] Bulk selection and batch actions
- [ ] Show created/updated timestamps
- [ ] Undo for reversible actions
- [ ] Animated transitions

## Custom rules

Your own additions — one checkable line each.

<!-- - [x] Every list is sorted newest-first by default -->
`;

/** Create the file if absent. Returns true when it was seeded now. */
export function ensureGlobalDoc(): boolean {
  const file = globalDocPath();
  if (existsSync(file)) return false;
  ensureHome();
  writeFileAtomic(file, TEMPLATE);
  return true;
}

/** The conventions text, seeding it first if absent. */
export function readGlobalDoc(): string {
  ensureGlobalDoc();
  return readFileSync(globalDocPath(), "utf8");
}
