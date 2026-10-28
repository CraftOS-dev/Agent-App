# Rails wiring (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# Every request the app serves comes here (config/routes.rb): the adapter
# answers its own routes — `dispatch(method, path, headers, body, query)` —
# and everything else is the built View, served from public/ by the
# adapter's StaticView with the framework's two pages beside it. The adapter
# owns the protocol; this controller only moves bytes. An agent evolves the
# app by editing `lib/a2app_schema.rb` and the View in `ui/` — never this
# file.
class A2appController < ActionController::Base
  # No Rails CSRF here, deliberately. Rails' tokens protect its own
  # cookie-authenticated HTML forms; this is an API adapter surface, and the
  # adapter carries its own protection: a browser request carrying a foreign
  # Origin is refused (403 forbidden_origin) before anything else runs, a
  # change made with a multi-user app's session cookie must carry the app's
  # own Origin (the cookie is SameSite=Lax besides), and agent writes
  # authenticate with the x-a2app-token header a foreign page cannot read. A
  # Rails CSRF check would only 422 the app's own View.
  skip_forgery_protection
  # The body is the adapter's to read (read_body); Rails' params are unused.
  wrap_parameters false

  # A protocol write is tiny; anything larger is a mistake or an attack.
  # The cap is enforced BEFORE parsing — an unauthenticated caller must never
  # be able to make the app parse an arbitrary amount of memory. Same cap and
  # envelope as @a2app/adapter-core's Node transport.
  MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024

  # An exception anywhere in a request is answered in the protocol's own
  # envelope, never with a Rails error page. Errors raised before this
  # controller runs (a path Rails cannot decode) reach the same answer
  # through config.exceptions_app.
  rescue_from StandardError, with: :adapter_error

  def handle
    body = nil
    if %w[POST PATCH PUT].include?(request.request_method)
      body, too_large = read_body
      if too_large
        # The client may still be uploading: answer, then close.
        response.headers["connection"] = "close"
        return render json: A2appAdapter::Js.dump(too_large), status: 413
      end
    end
    reply = self.class.adapter.dispatch(
      request.request_method, request.path, self.class.a2app_headers(request.env), body, request.query_string
    )
    return serve_view if reply.nil?
    status, payload, headers = reply
    (headers || {}).each { |name, value| response.headers[name] = value }
    render json: A2appAdapter::Js.dump(payload), status: status
  end

  class << self
    # The adapter is built once per process and shared across Puma's threads —
    # the SQLite store serializes its own access, and the adapter guards the
    # little state it keeps.
    def adapter
      ADAPTER_LOCK.synchronize { @adapter ||= build_adapter }
    end

    # The built View in public/, plus the framework's own pages at their
    # aliases: the update watcher an open tab imports at runtime (it is NOT
    # part of the View: the View is the agent's to rewrite entirely, the
    # watcher is not) and the account page (sign in, invites, people, the
    # agents acting for you). Its version — everything a browser tab is
    # actually running, plus the agent-owned schema (an operation's
    # description changes what the app tells an agent, yet moves neither
    # schemaVersion nor the View bytes), salted with manifest.appVersion — is
    # identity's `appVersion`.
    def view
      ADAPTER_LOCK.synchronize do
        @view ||= A2appAdapter::StaticView.new(
          Rails.root.join("public").to_s,
          aliases: {
            "/_a2app/update.js" => Rails.root.join("a2app-update.js").to_s,
            "/_a2app/account" => Rails.root.join("a2app-account.html").to_s,
          },
          fingerprint_paths: [Rails.root.join("lib", "a2app_schema.rb").to_s],
          version_salt: manifest["appVersion"].to_s
        )
      end
    end

    # config.exceptions_app: an exception raised outside the controller (a
    # path Rails cannot decode into route parameters) answered as
    # adapter-core answers any exception.
    def exception_reply(env)
      error = env["action_dispatch.exception"]
      payload = { "a2app" => true, "ok" => false, "code" => "adapter_error", "message" => error&.message.to_s }
      [500, { "content-type" => "application/json; charset=utf-8" }, [A2appAdapter::Js.dump(payload)]]
    end

    # The request headers the adapter routes on, in the lower-cased dashed
    # form it expects (host, origin, x-a2app-token, idempotency-key, …).
    def a2app_headers(env)
      out = {}
      env.each do |key, value|
        next unless key.is_a?(String)
        if key.start_with?("HTTP_")
          out[key[5..].downcase.tr("_", "-")] = value
        elsif key == "CONTENT_TYPE"
          out["content-type"] = value
        end
      end
      out
    end

    private

    def manifest
      @manifest ||= JSON.parse(Rails.root.join("manifest.json").read)
    end

    def build_adapter
      port = Integer(ENV.fetch("PORT") { manifest["port"] || 8096 })
      # The launch contract (`serve` and `dev` both set these; the default
      # covers a direct boot): A2APP_DATA_DIR is where records live — `serve`
      # passes the toolkit's declared lifecycle dataDir ("data" — what
      # backup/restore/promote protect); `dev` passes a fresh per-boot
      # directory, which is how a dev instance runs against a disposable
      # database that re-seeds from empty.
      data_dir = ENV.fetch("A2APP_DATA_DIR") { Rails.root.join("data").to_s }
      A2appAdapter::Adapter.new(
        app_id: manifest["id"],
        app_name: manifest["name"],
        entities: A2appSchema::ENTITIES,
        operations: A2appSchema::OPERATIONS,
        # Durable store: records and all adapter state (credentials, accounts,
        # tasks, events, approvals, idempotency keys, audit) in SQLite inside
        # the lifecycle dataDir. Seeded only when this boot CREATED the file.
        store: A2appAdapter::SqliteStore.new(File.join(data_dir, "db.sqlite"), A2appSchema::SEED),
        # The app's own .agent-token is its admin credential (spec/v0_2/auth.md §2.3).
        token: agent_token,
        # `multi-user` gives the app accounts, sign-in and per-person records;
        # `none` is a personal tool with one principal, the owner.
        auth_mode: manifest["authMode"] == "multi-user" ? "multi-user" : "none",
        # What each person may do (spec/v0_2/auth.md §3), when the schema says;
        # every agent acting for them is limited to the same.
        permissions_of: A2appSchema.const_defined?(:PERMISSIONS_OF, false) ? A2appSchema::PERMISSIONS_OF : nil,
        # What each capability's agent may do (spec/v0_2/auth.md §6.2).
        capabilities: A2appSchema.const_defined?(:CAPABILITIES, false) ? A2appSchema::CAPABILITIES : {},
        # Modules are declared in the manifest and are what describe's root
        # level lists; every entity and operation names one.
        modules: manifest["modules"] || [],
        allowed_origins: ["http://localhost:#{port}", "http://127.0.0.1:#{port}"],
        # config/puma.rb already refused an unsafe combination before binding.
        public_url: A2appAdapter::Network.policy(ENV["A2APP_HOST"], ENV["A2APP_PUBLIC_URL"])[1],
        operation_runners: A2appSchema::OPERATION_RUNNERS,
        # The event types this app may emit. A runner's `store.trigger` refuses
        # a type that is not declared here, so the set of things the app can
        # ever ask an agent to react to is fixed by its author in
        # lib/a2app_schema.rb.
        events: A2appSchema::EVENTS,
        env: ENV["A2APP_ENV"],
        app_version: -> { view.version }
      )
    end

    def agent_token
      file = Rails.root.join(".agent-token")
      return file.read.strip if file.exist?
      token = "a2app_" + SecureRandom.hex(24)
      File.write(file, token + "\n")
      begin
        File.chmod(0o600, file)
      rescue SystemCallError
        # Windows has no POSIX modes; the file still lives outside public/.
      end
      token
    end
  end

  ADAPTER_LOCK = Monitor.new

  private

  # A path outside the adapter's namespaces: a file of the View, or one of
  # the framework's pages, or the View's own 404.
  def serve_view
    status, headers, body = self.class.view.serve(request.request_method, request.path,
                                                  self.class.a2app_headers(request.env))
    headers.each { |name, value| response.headers[name] = value }
    self.status = status
    self.response_body = body || ""
  end

  def adapter_error(error)
    logger.error("#{error.class}: #{error.message}\n  #{Array(error.backtrace).first(8).join("\n  ")}")
    payload = { "a2app" => true, "ok" => false, "code" => "adapter_error", "message" => error.message }
    render json: A2appAdapter::Js.dump(payload), status: 500
  end

  # Parse the request body under the cap. Returns [body, nil] — nil when
  # there was none — or [nil, envelope] when it is too large. Bytes are
  # counted as they arrive from rack.input rather than trusting
  # Content-Length, so a client that lies about the length gains nothing.
  def read_body
    input = request.body
    size = 0
    chunks = []
    while (chunk = input.read(64 * 1024))
      break if chunk.empty?
      size += chunk.bytesize
      if size > MAX_REQUEST_BODY_BYTES
        return [nil, {
          "a2app" => true, "ok" => false, "code" => "payload_too_large",
          "message" => "Request body exceeds the #{MAX_REQUEST_BODY_BYTES}-byte limit.",
          "limitBytes" => MAX_REQUEST_BODY_BYTES,
        }]
      end
      chunks << chunk
    end
    # Read as UTF-8, a malformed byte as U+FFFD, as Node reads a body.
    text = chunks.join.force_encoding(Encoding::UTF_8).scrub
    return [nil, nil] if A2appAdapter::Js.trim(text).empty?
    begin
      # As JavaScript's JSON.parse: the last of a repeated key wins.
      [JSON.parse(text, allow_duplicate_key: true), nil]
    rescue JSON::ParserError
      # Hand the guard something it can reject by its own rules, rather than
      # raising into a 500 that tells the caller nothing. Same envelope as
      # adapter-core's parser.
      [{ "__unparsed__" => text }, nil]
    end
  end
end
