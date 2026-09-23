# Puma config (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# The launch contract: `agent-app <dir> serve` and `dev` set PORT (serve
# passes manifest.port; dev a hidden port); the fallback covers a direct
# `bundle exec puma -C config/puma.rb`. The CLI reaches a running app at the
# manifest's port, so the two must always agree.
require "json"

manifest = JSON.parse(File.read(File.expand_path("../manifest.json", __dir__)))
port = Integer(ENV.fetch("PORT") { manifest["port"] || 8096 })

# Bind loopback explicitly. Binding every interface would make the app
# reachable from the network while its own log line said localhost — and a
# same-origin request is trusted as the owner without a credential, which
# would make a scaffolded Agent App remotely writable by anyone who could
# reach the port. Exposing it must be a deliberate act, hence the env var.
host = ENV.fetch("A2APP_HOST", "127.0.0.1")
bind "tcp://#{host}:#{port}"

# Single mode (no workers): one process, a thread pool, one SQLite
# connection guarded by one mutex in the adapter's store. Forked workers
# would multiply writers against one WAL file for no gain at this scale.
threads 1, 5

environment ENV.fetch("RAILS_ENV", "development")
