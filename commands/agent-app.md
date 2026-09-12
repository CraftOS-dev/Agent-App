---
description: The front door to the Agent App Framework — build, evolve, operate, import, or verify an Agent App. Routes your request to the right framework skill and the agent-app / a2app CLIs. Use whenever the user wants software built, changed, or operated and you are not sure how to start.
argument-hint: [what you want, e.g. "build a CRM" | "add a report to my expense app" | "operate atlas-erp"]
---

You are the entry point to the **Agent App Framework**. An Agent App is a
self-contained full-stack web app that an agent operates through its A2App
adapter — never by driving the UI. Build and evolve go through the `agent-app`
CLI; operate goes through the `a2app` CLI. The method for each activity lives in
a framework **skill** — your job is to pick the right one, load it, and follow
it. Do not build or operate an app from general knowledge outside these skills.

## The request

$ARGUMENTS

## Route it

Read the request and load the matching framework skill (invoke it via the Skill
tool), then follow that skill end to end. If the request is empty or you cannot
tell which activity it is, ask the user which one before proceeding — do not
guess, and do not start building from general knowledge.

| The user wants to… | Load the skill |
|---|---|
| Build / make / scaffold a NEW app, tool, CRM, dashboard, internal tool | `creator` |
| Change / add a feature to / fix / redesign an EXISTING app | `modify` |
| Run / read data / operate / diagnose a running app (no code change) | `operator` |
| Install / import / adopt / convert an existing or foreign app | `importer` |
| Independently verify a built app against its requirements | `walk-verify` |
| Connect to a published app you do not own | `connect` |

## Finding the app (evolve / operate / verify)

If the activity targets an existing app but you are not inside its directory,
locate it first: `agent-app list` shows every known Agent App with its path,
port, and live status, and a command accepts a registered app id or name
wherever it accepts a directory. Once inside an app directory, its own
`AGENT_APP.md` and `reference/requirements.md` are the ground truth.

## Do not

- Do not build or edit an app from general knowledge outside these skills — the
  ownership boundary, the Agent App Quality Standard, and the validation gate all
  live in them.
- Do not drive the UI to operate an app; the adapter (`a2app`) is the only agent
  surface. The UI is for humans and for walk-verify.
