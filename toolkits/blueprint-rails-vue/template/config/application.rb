# Rails application (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# A deliberately minimal Rails::Application: only the railties this stack uses
# are loaded. ActiveRecord is NOT among them — records live in the adapter's
# own SQLite store (lib/a2app_adapter.rb, SqliteStore), so there is no
# database.yml, no migrations directory, and `rails generate model` has no
# place here. The agent evolves the app by editing lib/a2app_schema.rb and the
# View in ui/ — never this file.
require_relative "boot"

require "rails"
require "action_controller/railtie"

# Require the gems in the Gemfile (puma requires itself at boot; sqlite3 is
# loaded lazily by SqliteStore so the pure rules run gem-free).
Bundler.require(*Rails.groups)

module RailsVueAgentApp
  class Application < Rails::Application
    config.load_defaults 8.0

    # One process shape, everywhere. An Agent App is restarted by the
    # framework whenever its code changes (dev reboots, promote restarts), so
    # in-process code reloading buys nothing and costs determinism: eager-load
    # everything once at boot, in every environment. This also means no
    # config/environments/* files — the tree IS the configuration.
    config.enable_reloading = false
    config.eager_load = true

    # lib/ holds the adapter (system-owned) and the schema (agent-owned);
    # eager-load it so a broken schema fails the boot, not the first request.
    config.autoload_lib(ignore: [])

    # The View is served from public/ — the Vite build output (`npm --prefix
    # ui run build` compiles ui/ into it). Serve it with Cache-Control:
    # no-cache so a plain reload always revalidates: an open tab must see a
    # promoted View on its next fetch, and an unchanged file still costs only
    # a conditional round trip.
    config.public_file_server.enabled = true
    config.public_file_server.headers = { "Cache-Control" => "no-cache" }

    # No credentials ritual, on purpose. An Agent App must boot headlessly —
    # scaffolded, gated and served by a framework, with no human around to run
    # `rails credentials:edit` or export a master key. This app also keeps no
    # sessions and no cookies (the adapter's origin rule + agent token are the
    # whole auth surface), so secret_key_base signs nothing that matters; it
    # exists because Rails requires one to boot. Minted once into a
    # git-ignored runtime file, overridable via ENV.
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE") do
      require "securerandom"
      file = root.join("tmp", "secret_key_base")
      if File.exist?(file)
        File.read(file).strip
      else
        require "fileutils"
        FileUtils.mkdir_p(File.dirname(file))
        secret = SecureRandom.hex(64)
        File.write(file, secret + "\n")
        begin
          File.chmod(0o600, file)
        rescue SystemCallError
          # Windows has no POSIX modes; the file is git-ignored regardless.
        end
        secret
      end
    end

    # Host authorization would refuse headless boots and the Vite dev proxy by
    # Host header; the real exposure guard is the loopback bind in
    # config/puma.rb — reaching this app from the network requires a
    # deliberate A2APP_HOST override, not a Host header.
    config.hosts.clear

    # One stream: `agent-app serve` captures stdout as the app log.
    config.logger = ActiveSupport::Logger.new($stdout)
    config.log_level = :info
  end
end
