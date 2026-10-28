# Puma config (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# The launch contract: `agent-app <dir> serve` and `dev` set PORT (serve
# passes manifest.port; dev a hidden port); the fallback covers a direct
# `bundle exec puma -C config/puma.rb`. The CLI reaches a running app at the
# manifest's port, so the two must always agree.
require "json"
require_relative "../lib/a2app_adapter"

manifest = JSON.parse(File.read(File.expand_path("../manifest.json", __dir__)))
port = Integer(ENV.fetch("PORT") { manifest["port"] || 8096 })

# Where to listen, and the address people and agents use (A2APP_HOST,
# A2APP_PUBLIC_URL). Loopback unless the owner deliberately exposed the app:
# a same-origin request is trusted as the owner without a credential, so an
# app listening on the network by accident would be writable by anyone who
# could reach the port. A combination that would send the agent token across
# a network in clear is refused here, before anything is bound.
begin
  host, = A2appAdapter::Network.policy(ENV["A2APP_HOST"], ENV["A2APP_PUBLIC_URL"])
rescue ArgumentError => e
  abort e.message
end
bind "tcp://#{(IPAddr.new(host).ipv6? rescue false) ? "[#{host}]" : host}:#{port}"

# Single mode (no workers): one process, a thread pool, one SQLite
# connection guarded by one mutex in the adapter's store. Forked workers
# would multiply writers against one WAL file for no gain at this scale.
threads 1, 5

environment ENV.fetch("RAILS_ENV", "development")
