# Routes (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# One route, one handler: every request, on every path and verb, goes to
# A2appController#handle. The adapter's dispatch() is the router for the
# whole protocol surface (identity, describe, records, operations,
# tasks/events, accounts, credentials, sign-in), and whatever it does not own
# is the View: the built public/ tree, with the update watcher at
# /_a2app/update.js and the framework's account page at /_a2app/account. So
# there is nothing else: the adapter is the only agent surface, and the View
# (with the account page) the only human one. `format: false` keeps Rails
# from splitting a trailing ".json" off a path the adapter needs verbatim.
Rails.application.routes.draw do
  match "/", to: "a2app#handle", via: :all
  match "*path", to: "a2app#handle", via: :all, format: false
end
