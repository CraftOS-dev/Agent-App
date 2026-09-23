# Rails wiring (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# Translates the Rack request into the adapter's `dispatch(method, path,
# headers, body, query)` and renders what comes back. The adapter owns the
# protocol; this controller only moves bytes. An agent evolves the app by
# editing `lib/a2app_schema.rb` and the View in `ui/` — never this file.
class A2appController < ActionController::Base
  # No CSRF here, deliberately. CSRF tokens protect cookie-authenticated HTML
  # forms; this is an API adapter surface with no session and no cookies. The
  # adapter's own origin rule is the protection: a browser request carrying a
  # foreign Origin is refused (403 forbidden_origin) before anything else runs,
  # and agent writes authenticate with the x-a2app-token header a foreign page
  # cannot read. A CSRF check would only 422 the app's own View.
  skip_forgery_protection

  # A protocol write is tiny; anything larger is a mistake or an attack.
  # The cap is enforced BEFORE parsing — an unauthenticated caller must never
  # be able to make the app parse an arbitrary amount of memory. Same cap and
  # envelope as @a2app/adapter-core's Node transport and the python blueprint.
  MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024

  # /api/** — every A2App route (identity, describe, records, operations,
  # tasks/events) goes through the adapter's own router.
  def handle
    body = nil
    if %w[POST PATCH PUT].include?(request.request_method)
      body, too_large = read_body
      return render json: too_large[1], status: too_large[0] if too_large
    end
    status, payload = self.class.adapter.dispatch(
      request.request_method, request.path, a2app_headers, body, request.query_parameters
    )
    render json: payload, status: status
  end

  # /.well-known/a2app.json — the discovery document. The same identity the
  # adapter serves at /api/_a2app (dispatch owns that route), including the
  # appVersion the wiring's lambda contributes.
  def identity
    render json: self.class.adapter.identity
  end

  # /_a2app/update.js — the system-owned update watcher, served from the
  # project root (it is NOT part of the built View: the View is the agent's to
  # rewrite entirely, the watcher is not). no-cache so a promote is picked up
  # on the next probe, not whenever a heuristic cache expires.
  def update_watcher
    response.headers["Cache-Control"] = "no-cache"
    send_file Rails.root.join("a2app-update.js"),
              type: "text/javascript; charset=utf-8", disposition: "inline"
  end

  class << self
    # The adapter is built once per process and shared across Puma's threads —
    # the SQLite store serializes its own access, and the adapter itself keeps
    # no per-request state.
    def adapter
      ADAPTER_LOCK.synchronize { @adapter ||= build_adapter }
    end

    # identity's `appVersion`: a fingerprint of everything a browser tab is
    # actually running — the built View (public/**, sorted paths + contents),
    # the agent-owned schema (an operation's description changes what the app
    # tells an agent, yet moves neither schemaVersion nor the View bytes) and
    # the update watcher itself, salted with manifest.appVersion so an author
    # can move the marker by hand. Recomputed at most once per second: every
    # open tab polls identity, and hashing the whole View per probe would make
    # the watcher the app's main workload.
    def app_version
      VERSION_LOCK.synchronize do
        now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        if @app_version.nil? || now - @app_version_at >= 1.0
          @app_version = compute_app_version
          @app_version_at = now
        end
        @app_version
      end
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
        # Durable store: records + idempotency keys in SQLite inside the
        # lifecycle dataDir. Seeded only when this boot CREATED the file.
        store: A2appAdapter::SqliteStore.new(File.join(data_dir, "db.sqlite"), A2appSchema::SEED),
        token: agent_token,
        # Modules are declared in the manifest and are what describe's root
        # level lists; every entity and operation names one.
        modules: manifest["modules"] || [],
        allowed_origins: ["http://localhost:#{port}", "http://127.0.0.1:#{port}"],
        operation_runners: A2appSchema::OPERATION_RUNNERS,
        env: ENV["A2APP_ENV"],
        app_version: -> { app_version }
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

    def compute_app_version
      digest = Digest::SHA256.new
      digest.update(manifest["appVersion"].to_s)
      pub = Rails.root.join("public").to_s
      if Dir.exist?(pub)
        Dir.glob("**/*", base: pub).sort.each do |rel|
          full = File.join(pub, rel)
          next unless File.file?(full)
          digest.update(rel)
          digest.update(File.binread(full))
        end
      end
      [Rails.root.join("lib", "a2app_schema.rb"), Rails.root.join("a2app-update.js")].each do |extra|
        digest.update(File.binread(extra)) if File.exist?(extra)
      end
      "av_" + digest.hexdigest[0, 16]
    end
  end

  ADAPTER_LOCK = Mutex.new
  VERSION_LOCK = Mutex.new

  private

  # The A2App headers the adapter routes on, in the lower-cased dashed form it
  # expects (origin, x-a2app-token, idempotency-key, x-a2app-approval, …).
  def a2app_headers
    out = {}
    request.headers.env.each do |key, value|
      next unless key.is_a?(String)
      if key.start_with?("HTTP_")
        out[key[5..].downcase.tr("_", "-")] = value
      elsif key == "CONTENT_TYPE"
        out["content-type"] = value
      end
    end
    out
  end

  # Parse the request body under the cap. Returns [body, nil], or
  # [nil, [status, envelope]] when the body is too large. Bytes are counted as
  # they arrive from rack.input rather than trusting Content-Length, so a
  # client that lies about the length gains nothing.
  def read_body
    input = request.body
    size = 0
    chunks = []
    while (chunk = input.read(64 * 1024))
      break if chunk.empty?
      size += chunk.bytesize
      if size > MAX_REQUEST_BODY_BYTES
        return [nil, [413, {
          "a2app" => true, "ok" => false, "code" => "payload_too_large",
          "message" => "Request body exceeds the #{MAX_REQUEST_BODY_BYTES}-byte limit.",
          "limitBytes" => MAX_REQUEST_BODY_BYTES,
        }]]
      end
      chunks << chunk
    end
    raw = chunks.join
    return [{}, nil] if raw.strip.empty?
    begin
      [JSON.parse(raw), nil]
    rescue JSON::ParserError
      # Hand the guard something it can reject by its own rules, rather than
      # raising into a 500 that tells the caller nothing. Same envelope as
      # adapter-core's parser.
      [{ "__unparsed__" => raw.dup.force_encoding(Encoding::UTF_8).scrub }, nil]
    end
  end
end
