# Playground

A runnable Agent App, workspace-linked to `@a2app/adapter-core`, kept here as the
living example of the embedded-middleware adapter form. It is hand-built rather
than scaffolded: the blueprints are covered by the Toolkit conformance class, and
this app exists to be *walked*.

```bash
pnpm --filter @a2app/playground build
node apps/playground/dist/server.js          # http://127.0.0.1:8092

# writes need the app's agent credential; the CLI reads it from .agent-token (gitignored)
printf 'a2app_playground_token' > apps/playground/.agent-token
node framework/cli/dist/a2app.js apps/playground                              # root: 2 modules
node framework/cli/dist/a2app.js apps/playground directory                    # module
node framework/cli/dist/a2app.js apps/playground directory people             # entity: fields + ops
node framework/cli/dist/a2app.js apps/playground directory people c_ada       # record: what applies here
node framework/cli/dist/a2app.js apps/playground directory people c_ada touchpoints  # relation
node framework/cli/dist/a2app.js apps/playground --find tier                  # search
```

Each level answers on its own and stays inside the 2,000-char budget; the gate
measures all six of them:

```bash
node framework/cli/dist/agent-app.js apps/playground validate --no-build
# ✓ describe budget (every level ≤ 2,000 chars) — 6 level(s)
```

The seed is chosen so each state-gated operation is blocked on one record and
available on another — `promote-to-customer` is blocked on Ada (already a
customer) and available on Charles (a lead). A seed where everything is available
would render the same screen as an app with no predicates at all.

See [AGENT_APP.md](AGENT_APP.md) for the model and
[reference/requirements.md](reference/requirements.md) for what it is meant to do.
