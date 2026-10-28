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

# The adapter, for the Host check below (it is eager-loaded with lib/ too).
require_relative "../lib/a2app_adapter"

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

    # The View is the Vite build output in public/ (`npm --prefix ui run
    # build` compiles ui/ into it), and the adapter's wiring serves it — not
    # Rails' static file server, which would answer before routing, outside
    # the Host check, with no ETag. A2appController serves every file with
    # ETag, Last-Modified and Cache-Control: no-cache, so a plain reload
    # always revalidates: an open tab sees a promoted View on its next fetch,
    # and an unchanged file costs a bodyless 304.
    config.public_file_server.enabled = false

    # The Host check, in front of everything this app serves: the adapter's
    # routes, the View, and anything Rails adds itself. A request naming a
    # host the app does not answer to is refused 403 forbidden_host — which
    # is what stops a page whose DNS re-resolves to 127.0.0.1 from reading
    # the app. Rails' own host authorization (config.hosts, cleared here) is
    # not used: the adapter derives its hosts from the app's origins and its
    # A2APP_PUBLIC_URL, and refuses in the protocol's own envelope.
    config.hosts.clear
    config.middleware.insert_after Rails::Rack::Logger, A2appAdapter::HostGuard, -> { A2appController.adapter }

    # An exception raised before the controller runs (a path Rails cannot
    # decode into route parameters) is answered in the protocol's envelope,
    # never with a Rails error page.
    config.exceptions_app = ->(env) { A2appController.exception_reply(env) }

    # The adapter reads every request body itself, under its 5 MiB cap
    # (A2appController#read_body). Rails never parses one: a body is not
    # parsed twice nor past the cap, and its contents — passwords, device and
    # confirmation codes, tokens — never reach the log's "Parameters:" line.
    ActiveSupport.on_load(:action_dispatch_request) { self.parameter_parsers = {} }
    # What the log still shows (query strings, and a form-encoded body Rack
    # parses) has any secret-shaped value filtered out.
    config.filter_parameters += %i[passw token code confirmation secret]

    # No credentials ritual, on purpose. An Agent App must boot headlessly —
    # scaffolded, gated and served by a framework, with no human around to run
    # `rails credentials:edit` or export a master key. Rails' own sessions and
    # signed cookies are unused (the adapter's origin rule, its credentials
    # and, on a multi-user app, its own random session secrets — stored as
    # hashes, never signed by Rails — are the whole auth surface), so
    # secret_key_base signs nothing that matters; it exists because Rails
    # requires one to boot. Minted once into a git-ignored runtime file,
    # overridable via ENV.
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

    # One stream: `agent-app serve` captures stdout as the app log.
    config.logger = ActiveSupport::Logger.new($stdout)
    config.log_level = :info
  end
end
