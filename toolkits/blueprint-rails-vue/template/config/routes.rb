# Routes (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# Route ownership, in order: (1) ActionDispatch::Static answers everything
# that exists in public/ — the built View — before routing runs at all;
# (2) the A2App adapter answers every /api/** path through its own router;
# (3) the two system endpoints below. There is nothing else: the adapter is
# the only agent surface, and the View is the only human one.
Rails.application.routes.draw do
  # The discovery document, and the system-owned update watcher an open tab
  # imports at runtime (see a2app-update.js at the project root).
  get "/.well-known/a2app.json", to: "a2app#identity"
  get "/_a2app/update.js", to: "a2app#update_watcher"

  # Every verb, one handler: the adapter's dispatch() is the router for the
  # whole protocol surface (identity, describe, records CRUD, operations,
  # tasks/events). `format: false` keeps Rails from splitting a trailing
  # ".json" off a path the adapter needs verbatim.
  match "/api/*rest", to: "a2app#handle", via: :all, format: false

  # "/" is the View. Rails serves public/index.html automatically for the
  # root path when the file exists (the static file server answers before
  # routing) — this redirect is only the honest fallback for a tree whose
  # View has not been built yet, so the symptom is a clean 404 on
  # /index.html rather than a routing error.
  root to: redirect("/index.html")
end
