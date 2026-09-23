# A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# A faithful Ruby port of the A2App served surface: identity, describe, whoami,
# context, guarded records CRUD, declared operations (with approval for
# destructive ops), and the app->agent task/event plane. It enforces the fixed
# validation chain: origin -> credential -> scope -> guard -> backend -> read-back.
# Records persist in SQLite (the `sqlite3` gem — see SqliteStore), so the live
# database is a real on-disk file inside the toolkit's declared lifecycle dataDir.
#
# The pure validation rules below MUST match `@a2app/rules` (and the python
# blueprint's a2app_adapter.py, which is this file's porting oracle) so a Rails
# app and a Node app reject identical payloads identically — verified by the
# conformance suite. Rails wiring lives in app/controllers/a2app_controller.rb;
# this file never requires Rails. An agent evolves the app by editing
# lib/a2app_schema.rb, never this file.
#
# The pure-rules sections and their selftest parts run on a bare Ruby with no
# gems: `sqlite3` is required only inside SqliteStore, and its absence fails
# loudly there — never silently.
require "json"
require "digest"
require "securerandom"
require "time"
# stdlib, not gems: uri for query-string parsing (parity with python's
# parse_qs), fileutils for creating the data directory on first boot.
require "uri"
require "fileutils"

module A2appAdapter
  RULES_VERSION = "0.1.0"
  PROTOCOL_VERSION = "0.1"
  ADAPTER_VERSION = "0.1.0"

  ERROR_CODES = {
    "UNKNOWN_FIELD" => "unknown_field",
    "READ_ONLY_FIELD" => "read_only_field",
    "INVALID_DATE" => "invalid_date",
    "INVALID_DAYKEY" => "invalid_daykey",
    "INVALID_STRING" => "invalid_string",
    "INVALID_NUMBER" => "invalid_number",
    "INVALID_BOOLEAN" => "invalid_boolean",
    "INVALID_ENUM" => "invalid_enum",
    "NOT_STORED" => "not_stored",
    "DUPLICATE_REQUEST" => "duplicate_request",
    "APPROVAL_REQUIRED" => "approval_required",
    "INSUFFICIENT_SCOPE" => "insufficient_scope",
    "AMBIGUOUS_REF" => "ambiguous_ref",
    "INVALID_EVENT" => "invalid_event",
    "TASK_NOT_FOUND" => "task_not_found",
    "TASK_NOT_CLAIMABLE" => "task_not_claimable",
    "TASK_CANCELED" => "task_canceled",
    "AGENT_TOKEN_REQUIRED" => "agent_token_required",
    "RATE_LIMITED" => "rate_limited",
    # The record is still referenced, and a `ref` pointing at it says `restrict`.
    "RECORD_REFERENCED" => "record_referenced",
  }.freeze

  # What a `ref` does when nothing says otherwise: refuse the delete. Silently
  # orphaning is the worse default — it is invisible at the moment it happens,
  # and the app that has to cope with it is the one reading the record weeks
  # later. A field opts out with `onDelete: "ignore"`.
  #
  # There is deliberately no `cascade` or `detach`: both would let one delete
  # write to records the caller never named, which an agent cannot approve in
  # advance and an audit log cannot explain afterwards. That belongs in a
  # declared operation.
  DEFAULT_ON_DELETE = "restrict"

  # Page size for the referential scan a delete runs before it commits.
  REFERENCE_SCAN_PAGE = 500
  # How many blocking record ids are reported per field: the answer is "yes,
  # and here are examples", not a dump of every row in the way.
  REFERENCE_SCAN_LIMIT = 10
  # Hard stop on paging, so a store that ignores `page` cannot spin forever.
  REFERENCE_SCAN_MAX_PAGES = 200

  DESCRIBE_BUDGET_CHARS = 2000

  DEFAULT_RATE_LIMITS = { "data" => 1200, "ops" => 300 }.freeze

  MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].freeze
  DATE_RE = /\A(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?\z/
  DAY_RE = /\A(\d{4})-(\d{2})-(\d{2})\z/

  # The single-clause filter grammar this backend implements — `field = "value"`,
  # `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in
  # one pair of parentheses. Enough for label->id resolution; a richer backend
  # exposes its own query language. Anything outside it is REFUSED, never
  # ignored: a store that accepts `filter` and returns unfiltered rows answers
  # 200 with the wrong records, which turns every label lookup into a false
  # multi-match. Parity: the react-node blueprint's matchFilter in server.mjs.
  FILTER_RE = /\A\s*\(?\s*([A-Za-z_]\w*)\s*(=|!=|~)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'()]+))\s*\)?\s*\z/

  # Raised when a `filter` expression falls outside the grammar above.
  class UnsupportedFilter < StandardError
    attr_reader :expression

    def initialize(expression)
      super("filter expression is not supported by this backend: #{expression}")
      @expression = expression
    end
  end

  # ------------------------------------------------------------- pure rules
  # Included by Store and Adapter; also callable as A2appAdapter::Rules.xxx.
  # Records are Hashes with STRING keys everywhere — JSON.parse without
  # symbolizing, so what the wire carries is what the rules see.
  module Rules
    module_function

    def valid_ymd(y, m, d)
      return false if m < 1 || m > 12 || d < 1
      mx = MONTH[m - 1]
      mx = 29 if m == 2 && y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
      d <= mx
    end

    def looks_like_date(v)
      return false unless v.is_a?(String)
      m = DATE_RE.match(v)
      !m.nil? && valid_ymd(m[1].to_i, m[2].to_i, m[3].to_i)
    end

    def day_key_value?(v)
      return false unless v.is_a?(String)
      m = DAY_RE.match(v)
      !m.nil? && valid_ymd(m[1].to_i, m[2].to_i, m[3].to_i)
    end

    def blank_value?(v)
      v.nil? || v == ""
    end

    def violation(code, field, expected, got)
      { "code" => code, "field" => field, "expected" => expected, "got" => got }
    end

    def number_string?(s)
      Float(s)
      true
    rescue TypeError, ArgumentError
      false
    end

    # Validate a RAW body against normalized fields; returns every violation.
    def validate(fields, body, allow = nil)
      allow ||= {}
      by_name = fields.to_h { |f| [f["name"], f] }
      writable = fields.reject { |f| f["readOnly"] }.map { |f| f["name"] }
      out = []
      body.each do |key, value|
        next if allow[key]
        f = by_name[key]
        if f.nil?
          out << violation(ERROR_CODES["UNKNOWN_FIELD"], key, "one of: " + writable.join(", "), value)
          next
        end
        if f["readOnly"]
          out << violation(ERROR_CODES["READ_ONLY_FIELD"], key, "not writable (server-managed)", value)
          next
        end
        next if blank_value?(value)
        ftype = f["type"]
        if ftype == "datetime" && !looks_like_date(value)
          out << violation(ERROR_CODES["INVALID_DATE"], key, "an ISO 8601 date", value)
        elsif f["dayKey"] && !day_key_value?(value)
          out << violation(ERROR_CODES["INVALID_DAYKEY"], key, 'a day key "YYYY-MM-DD"', value)
        elsif ftype == "string" && !value.is_a?(String)
          out << violation(ERROR_CODES["INVALID_STRING"], key, "text", value)
        elsif ftype == "number" && !value.is_a?(Numeric) &&
              !(value.is_a?(String) && value.strip != "" && number_string?(value))
          out << violation(ERROR_CODES["INVALID_NUMBER"], key, "a number", value)
        elsif ftype == "boolean" && value != true && value != false && !["true", "false"].include?(value)
          out << violation(ERROR_CODES["INVALID_BOOLEAN"], key, "true or false", value)
        elsif ftype == "enum" && f["values"] &&
              !f["values"].map { |v| render_plain(v) }.include?(render_plain(value))
          out << violation(ERROR_CODES["INVALID_ENUM"], key, "one of: " + f["values"].map { |v| render_plain(v) }.join(" | "), value)
        elsif ftype == "list<enum>" && f["values"]
          items = value.is_a?(Array) ? value : [value]
          allowed = f["values"].map { |v| render_plain(v) }
          if items.any? { |i| !allowed.include?(render_plain(i)) }
            out << violation(ERROR_CODES["INVALID_ENUM"], key, "each of: " + f["values"].map { |v| render_plain(v) }.join(" | "), value)
          end
        end
      end
      out
    end

    # str() for enum comparison — JSON booleans render "true"/"false".
    def render_plain(v)
      return "true" if v == true
      return "false" if v == false
      v.to_s
    end

    # Read-back backstop: which non-blank requested values failed to land?
    def divergences(fields, body, read)
      by_name = fields.to_h { |f| [f["name"], f] }
      out = []
      body.each do |key, requested|
        f = by_name[key]
        next if f.nil? || f["readOnly"]
        next if blank_value?(requested)
        stored = begin
          read.call(key)
        rescue StandardError
          nil
        end
        out << { "field" => key, "type" => f["type"], "stored" => stored.to_s } if blank_value?(stored)
      end
      out
    end

    def label_field_of(fields)
      names = fields.map { |f| f["name"] }
      %w[title name label].each { |pref| return pref if names.include?(pref) }
      fields.each do |f|
        return f["name"] if f["type"] == "string" && f["required"] && !f["readOnly"]
      end
      nil
    end

    # Every published attribute of a field, rendered deterministically.
    #
    # Must match `fieldPrint` in @a2app/rules exactly: a client that caches
    # describe against this value is told never to write against a stale
    # schema, so narrowing an enum or tightening a max has to move the hash.
    def field_print(f)
      parts = ["#{f["name"]}:#{f["type"]}"]
      parts << "req" if f["required"]
      parts << "ro" if f["readOnly"]
      parts << "wo" if f["writeOnly"]
      parts << "day" if f["dayKey"]
      parts << "max=#{f["max"]}" unless f["max"].nil?
      parts << "entity=#{f["entity"]}" if f["entity"]
      parts << "values=" + f["values"].sort.join("|") if f["values"]
      parts.join(":")
    end

    # JSON with keys sorted at every depth and compact separators, so
    # declaration order cannot move a hash. Parity: python's
    # json.dumps(sort_keys=True, separators=(",", ":")).
    def stable_json(value)
      case value
      when Hash
        "{" + value.keys.map(&:to_s).sort.map { |k| k.to_json + ":" + stable_json(value[k]) }.join(",") + "}"
      when Array
        "[" + value.map { |v| stable_json(v) }.join(",") + "]"
      else
        value.to_json
      end
    end

    def operation_print(o)
      flags = [["d", "destructive"], ["r", "readOnly"], ["i", "idempotent"]]
        .select { |_c, k| o[k] }.map { |c, _k| c }.join
      parts = [flags.empty? ? o["name"] : "#{o["name"]}:#{flags}"]
      parts << "mod=#{o["module"]}" if o["module"]
      parts << "on=#{o["entity"]}" if o["entity"]
      parts << "params=" + stable_json(o["params"]) if o["params"] && !o["params"].empty?
      parts << "when=" + stable_json(o["appliesWhen"]) if o["appliesWhen"]
      parts.join(":")
    end

    # Stable fingerprint of everything describe publishes.
    #
    # Parity oracle: @a2app/rules `schemaFingerprint`. `entities` maps a name to
    # {"fields" => [...], "module" => str, "auth"? => bool}. `module` is
    # required for the same reason it is required there: an entity that could
    # move between modules without moving the hash would leave caches placing
    # it in the old one.
    def schema_fingerprint(entities, operations = nil)
      parts = entities.map do |name, value|
        attrs = ["#{name}(#{value["fields"].map { |f| field_print(f) }.sort.join(",")})"]
        attrs << "auth" if value["auth"]
        attrs << "mod=#{value["module"]}"
        attrs.join(":")
      end
      parts.sort!
      ops = (operations || []).map { |o| operation_print(o) }.sort
      joined = parts.join(";") + "|" + ops.join(",")
      h = 5381
      joined.each_char { |ch| h = ((h * 33) ^ ch.ord) & 0xFFFFFFFF }
      "sv_" + h.to_s(16)
    end

    # -- availability predicates (A2APP-SPEC 3.4) ---------------------------
    # Parity oracle: adapters/rules/src/predicate.ts. Same predicate + same
    # record must yield the same availability and the same blocked reason on
    # every stack.

    # Read a value as its field's DECLARED type.
    #
    # A backend is only obliged to return what it stored, so `done: "true"` and
    # `done: true` are the same boolean. Deciding from the runtime type instead
    # would make availability depend on the storage engine.
    def as_declared(value, declared_type)
      return nil if blank_value?(value)
      if declared_type == "boolean"
        return value if value == true || value == false
        return true if value == "true"
        return false if value == "false"
        return value
      end
      if declared_type == "number"
        return value if value == true || value == false
        return value if value.is_a?(Numeric)
        begin
          return Float(value)
        rescue TypeError, ArgumentError
          return value
        end
      end
      value
    end

    def same_value(a, b)
      return stable_json(a) == stable_json(b) if a.is_a?(Array) || a.is_a?(Hash) || b.is_a?(Array) || b.is_a?(Hash)
      a_bool = a == true || a == false
      b_bool = b == true || b == false
      return false if a_bool != b_bool
      return a == b if a.is_a?(Numeric) && b.is_a?(Numeric)
      a == b
    end

    def read_field(record, name, index)
      as_declared(record[name], (index[name] || {})["type"])
    end

    def evaluate_predicate(predicate, record, fields)
      index = fields.to_h { |f| [f["name"], f] }
      evaluate(predicate, record, index)
    end

    def evaluate(p, record, index)
      return p["all"].all? { |sub| evaluate(sub, record, index) } if p.key?("all")
      return p["any"].any? { |sub| evaluate(sub, record, index) } if p.key?("any")
      return !evaluate(p["not"], record, index) if p.key?("not")

      actual = read_field(record, p["field"], index)
      declared = (index[p["field"]] || {})["type"]
      return (actual.nil?) == p["isBlank"] if p.key?("isBlank")
      return same_value(actual, as_declared(p["eq"], declared)) if p.key?("eq")
      return !same_value(actual, as_declared(p["ne"], declared)) if p.key?("ne")
      return p["in"].any? { |c| same_value(actual, as_declared(c, declared)) } if p.key?("in")
      return p["notIn"].none? { |c| same_value(actual, as_declared(c, declared)) } if p.key?("notIn")
      # Unrecognised form: refuse rather than default to available. An unknown
      # condition must never silently unblock an action.
      false
    end

    def render_value(v)
      return "blank" if v.nil?
      return "\"#{v}\"" if v.is_a?(String)
      return stable_json(v) if v.is_a?(Array) || v.is_a?(Hash)
      v.to_json
    end

    # Every field name a predicate reads, for declaration-time validation.
    def predicate_fields(predicate)
      out = []
      collect = lambda do |p|
        if p.key?("all")
          p["all"].each { |sub| collect.call(sub) }
        elsif p.key?("any")
          p["any"].each { |sub| collect.call(sub) }
        elsif p.key?("not")
          collect.call(p["not"])
        elsif p["field"] && !out.include?(p["field"])
          out << p["field"]
        end
      end
      collect.call(predicate)
      out
    end

    def render_list(values)
      parts = values.map { |v| render_value(v) }
      return parts.join if parts.length <= 1
      parts[0..-2].join(", ") + " or " + parts[-1]
    end

    # Why this predicate does not hold, derived — never composed by a model.
    def explain_predicate(predicate, record, fields)
      index = fields.to_h { |f| [f["name"], f] }
      return "the condition holds" if evaluate(predicate, record, index)
      explain(predicate, record, index)
    end

    def explain(p, record, index)
      if p.key?("all")
        p["all"].each do |sub|
          return explain(sub, record, index) unless evaluate(sub, record, index)
        end
        return "the condition holds"
      end
      if p.key?("any")
        return p["any"].empty? ? "no condition is satisfiable" : explain(p["any"][0], record, index)
      end
      if p.key?("not")
        inner = p["not"]
        if inner.key?("isBlank")
          return inner["isBlank"] ? "#{inner["field"]} is blank" : "#{inner["field"]} is set"
        end
        return "#{inner["field"]} is #{render_value(read_field(record, inner["field"], index))}" if inner.key?("eq")
        return "the condition is not met"
      end

      actual = read_field(record, p["field"], index)
      if p.key?("isBlank")
        return "#{p["field"]} is set to #{render_value(actual)}, not blank" if p["isBlank"]
        return "#{p["field"]} is blank"
      end
      return "#{p["field"]} is #{render_value(actual)}, not #{render_value(p["eq"])}" if p.key?("eq")
      return "#{p["field"]} is #{render_value(actual)}" if p.key?("ne")
      return "#{p["field"]} is #{render_value(actual)}, not #{render_list(p["in"])}" if p.key?("in")
      return "#{p["field"]} is #{render_value(actual)}" if p.key?("notIn")
      "the condition is not met"
    end

    def describe_violation(v, server_now = nil)
      msg = "Rejected by a2app (" + v["code"] + '): field "' + v["field"] + '" expects ' +
            v["expected"] + "; got " + v["got"].to_json
      if [ERROR_CODES["INVALID_DATE"], ERROR_CODES["INVALID_DAYKEY"]].include?(v["code"]) && server_now
        msg += '. Example: "' + server_now[0, 10] + '"'
      end
      msg += ". Server time is " + server_now if server_now
      msg + "."
    end

    def describe_incomplete(lost)
      names = lost.map { |l| l["field"] }.join(", ")
      "Rejected by a2app (not_stored): the database did not store " + names + ". Do NOT report this as done."
    end

    def filter_str(value)
      return "" if value.nil?
      return "true" if value == true
      return "false" if value == false
      value.to_s
    end

    def match_filter(expr)
      m = FILTER_RE.match(expr)
      raise UnsupportedFilter, expr if m.nil?
      field, op, quoted, single_quoted, bare = m.captures
      # Only the double-quoted form carries escapes; unescape exactly what the
      # escaping side wrote (backslash-x -> x).
      value =
        if !quoted.nil?
          quoted.gsub(/\\(.)/) { Regexp.last_match(1) }
        else
          single_quoted.nil? ? (bare || "") : single_quoted
        end
      lambda do |record|
        current = filter_str(record[field])
        case op
        when "=" then current == value
        when "!=" then current != value
        else current.include?(value)
        end
      end
    end

    def now_iso
      Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
    end

    def coerce(field, value)
      return value if value.nil? || value == ""
      if field["type"] == "number" && value.is_a?(String)
        return value.include?(".") ? value.to_f : value.to_i
      end
      return value == "true" if field["type"] == "boolean" && value.is_a?(String)
      value
    end

    # Percent-decode one path segment (parity with python's urllib unquote:
    # no "+"-to-space translation — that belongs to query strings only).
    def unquote(s)
      s.gsub(/%([0-9A-Fa-f]{2})/) { [Regexp.last_match(1)].pack("H2") }.force_encoding(Encoding::UTF_8)
    end

    def approval_key(name, args)
      "ak_" + Digest::SHA256.hexdigest(stable_json({ "args" => args, "op" => name }))[0, 32]
    end
  end

  # ----------------------------------------------------------- rate limiter
  class RateLimiter
    def initialize(limits, now_ms)
      @limits = limits
      @now_ms = now_ms
      @windows = {}
    end

    def check(caller_id, cls)
      limit = @limits[cls] || 0
      return { "allowed" => true, "limit" => limit, "retryAfterSeconds" => 0 } if limit <= 0
      now = @now_ms.call
      key = [caller_id, cls]
      ws, count = @windows[key] || [now, 0]
      if now - ws >= 60_000
        ws = now
        count = 0
      end
      count += 1
      @windows[key] = [ws, count]
      if count > limit
        return { "allowed" => false, "limit" => limit,
                 "retryAfterSeconds" => [1, (60_000 - (now - ws)) / 1000].max }
      end
      { "allowed" => true, "limit" => limit, "retryAfterSeconds" => 0 }
    end
  end

  # ------------------------------------------------------------------ store

  # In-memory record store plus adapter-owned state (tasks, events,
  # idempotency keys, approvals, audit). The blueprint's live store is
  # SqliteStore below (same interface, records + idempotency keys durable);
  # this base class is the disposable variant for tests and tooling.
  class Store
    include Rules

    attr_reader :seed, :rows, :tasks, :events
    attr_accessor :wants_seed

    def initialize(seed = nil)
      @seed = seed || {}
      # A fresh in-memory store is always empty, so it always takes the seed.
      # SqliteStore sets this false when the database file already existed:
      # re-seeding an existing database on every boot would resurrect a seed
      # record the user deleted.
      @wants_seed = true
      @rows = {}
      @tasks = {}
      @events = []
      @idem = {}
      @approvals = {}
      @audit = []
      @grants = {}
      @task_seq = 0
      @event_seq = 0
    end

    # records ---------------------------------------------------------------

    # Every record of one entity — the single hook a durable subclass
    # overrides for reads; list_records keeps the shared filter/sort/page.
    def all_records(entity)
      (@rows[entity] || {}).values
    end

    def list_records(entity, query)
      items = all_records(entity)
      flt = query["filter"]
      items = items.select(&match_filter(flt)) if flt && flt != ""
      sort = query["sort"]
      if sort && sort != ""
        desc = sort.start_with?("-")
        key = desc ? sort[1..] : sort
        items = items.sort_by { |r| [r[key].nil? ? 1 : 0, filter_str(r[key])] }
        items.reverse! if desc
      end
      total = items.length
      per_page = query["perPage"] ? Integer(query["perPage"]) : total
      page = query["page"] ? Integer(query["page"]) : 1
      start = per_page.positive? ? (page - 1) * per_page : 0
      {
        "items" => per_page.positive? ? items[start, per_page] || [] : items,
        "page" => page, "perPage" => per_page, "totalItems" => total,
      }
    end

    def get_record(entity, rec_id)
      (@rows[entity] || {})[rec_id]
    end

    def put_record(entity, rec)
      (@rows[entity] ||= {})[rec["id"]] = rec
    end

    def delete_record(entity, rec_id)
      table = @rows[entity] || {}
      return false unless table.key?(rec_id)
      table.delete(rec_id)
      true
    end

    # grants ----------------------------------------------------------------
    def put_grant(grant)
      @grants[grant["token"]] = grant
    end

    def grant_by_token(token)
      @grants[token]
    end

    # idempotency / approvals ----------------------------------------------
    def idem_get(entity, key)
      @idem[[entity, key]]
    end

    def idem_put(entity, key, rec_id)
      @idem[[entity, key]] = rec_id
    end

    def approval_issue(key)
      @approvals[key] = true
    end

    def approval_consume(key)
      return false unless @approvals.key?(key)
      @approvals.delete(key)
      true
    end

    # tasks / events --------------------------------------------------------
    def append_event(etype, payload)
      @event_seq += 1
      ev = { "id" => "ev_#{@event_seq}", "app" => nil, "type" => etype, "payload" => payload,
             "createdAt" => now_iso, "seq" => @event_seq }
      @events << ev
      ev
    end

    def events_since(cursor)
      after = cursor && cursor.match?(/\A\d+\z/) ? cursor.to_i : 0
      fresh = @events.select { |e| e["seq"] > after }
      { "events" => fresh, "nextCursor" => fresh.empty? ? (cursor || "0") : fresh[-1]["seq"].to_s }
    end

    def enqueue_task(event_id, capability, payload)
      @task_seq += 1
      task = {
        "id" => "task_#{@task_seq}", "app" => nil, "event" => event_id, "status" => "submitted",
        "request" => { "capability" => capability, "payload" => payload }, "claim" => nil,
        "progress" => {}, "result" => nil, "reason" => nil, "ask" => nil,
        "createdAt" => now_iso, "updatedAt" => now_iso, "deliveries" => 0,
      }
      @tasks[task["id"]] = task
      task
    end

    def list_tasks(status)
      @tasks.values.select { |t| status.nil? || t["status"] == status }
    end

    def get_task(task_id)
      @tasks[task_id]
    end

    def save_task(task)
      task["updatedAt"] = now_iso
      @tasks[task["id"]] = task
    end
  end

  # The blueprint's live store: records + idempotency keys in SQLite (the
  # `sqlite3` gem — the store, NOT ActiveRecord; this stack never loads AR).
  #
  # Records are JSON rows in one table keyed (entity, id): the schema stays
  # declarative and additive (a new field simply appears in the JSON) while
  # the DATABASE is a real on-disk file inside the toolkit's declared
  # lifecycle dataDir — which is what backup/restore/promote protect. WAL
  # keeps a reader and a writer from blocking each other.
  #
  # Idempotency keys persist because a restart is exactly when a retried POST
  # arrives — an in-memory table would return a duplicate record instead of
  # the 409 the protocol promises. The task/event plane, approvals, grants
  # and audit stay in memory: they are runtime queues and session state, not
  # records.
  #
  # Writes are durable when the call returns — there is no separate persist()
  # step. A hash read from this store is a COPY: mutate it, then put_record()
  # it back, or the change never happened.
  class SqliteStore < Store
    def initialize(path, seed = nil)
      super(seed)
      # The gem is loaded HERE, not at the top of the file, so the pure rules
      # and their selftest parts run on a bare Ruby. If it is missing, fail
      # loudly — a store that silently fell back to memory would report
      # durable writes that vanish on restart.
      begin
        require "sqlite3"
      rescue LoadError
        raise "the sqlite3 gem is not installed — run `bundle install` first"
      end
      full = File.expand_path(path)
      FileUtils.mkdir_p(File.dirname(full))
      fresh = !File.exist?(full)
      # Puma services requests on a thread pool; one connection guarded by one
      # mutex keeps this correct without a pool.
      @mutex = Mutex.new
      @db = SQLite3::Database.new(full)
      @mutex.synchronize do
        @db.execute("PRAGMA journal_mode=WAL")
        @db.execute(
          "CREATE TABLE IF NOT EXISTS records (" \
          "entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, " \
          "PRIMARY KEY (entity, id))"
        )
        @db.execute(
          "CREATE TABLE IF NOT EXISTS idem (" \
          "entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, " \
          "PRIMARY KEY (entity, key))"
        )
      end
      @wants_seed = fresh
    end

    # Release the database file (the last connection closing checkpoints the
    # WAL into the main file).
    def close
      @db.close
    end

    # records ---------------------------------------------------------------
    def all_records(entity)
      rows = @mutex.synchronize { @db.execute("SELECT data FROM records WHERE entity = ?", [entity]) }
      rows.map { |row| JSON.parse(row[0]) }
    end

    def get_record(entity, rec_id)
      row = @mutex.synchronize do
        @db.get_first_row("SELECT data FROM records WHERE entity = ? AND id = ?", [entity, rec_id])
      end
      row.nil? ? nil : JSON.parse(row[0])
    end

    def put_record(entity, rec)
      @mutex.synchronize do
        @db.execute(
          "INSERT INTO records (entity, id, data) VALUES (?, ?, ?) " \
          "ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
          [entity, rec["id"], JSON.generate(rec)]
        )
      end
      rec
    end

    def delete_record(entity, rec_id)
      @mutex.synchronize do
        @db.execute("DELETE FROM records WHERE entity = ? AND id = ?", [entity, rec_id])
        @db.changes > 0
      end
    end

    # idempotency -----------------------------------------------------------
    def idem_get(entity, key)
      row = @mutex.synchronize do
        @db.get_first_row("SELECT rec_id FROM idem WHERE entity = ? AND key = ?", [entity, key])
      end
      row.nil? ? nil : row[0]
    end

    def idem_put(entity, key, rec_id)
      @mutex.synchronize do
        @db.execute(
          "INSERT INTO idem (entity, key, rec_id) VALUES (?, ?, ?) " \
          "ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id",
          [entity, key, rec_id]
        )
      end
    end
  end

  # ---------------------------------------------------------------- adapter
  class Adapter
    include Rules

    attr_reader :store

    def initialize(app_id:, app_name:, entities:, operations:, store:, token:,
                   modules: nil, allowed_origins: nil, operation_runners: nil,
                   auth_mode: "none", credential_hint: nil, env: nil, app_version: nil)
      @app_id = app_id
      @app_name = app_name
      # {name => {"fields" => [...], "module" => str, "summary"?, "auth"?, "writeAllow"?}}
      @entity_defs = entities
      @operations = operations
      @modules = modules || []
      @op_by_name = operations.to_h { |o| [o["name"], o] }
      problems = model_problems
      unless problems.empty?
        # Fail fast: a model whose entities or operations name a module that
        # was never declared cannot be walked, so serving it would answer 200
        # while omitting real capability.
        raise ArgumentError,
              "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - " +
              problems.join("\n  - ")
      end
      @store = store
      @auth_mode = auth_mode
      @allowed_origins = (allowed_origins || []).to_h { |o| [o, true] }
      @runners = operation_runners || {}
      @credential_hint = credential_hint || "Read the app's .agent-token file (mode 0600) in the project directory."
      @env = env
      # Deliberate small extension over the python oracle: dispatch owns the
      # identity route inside the adapter, so the wiring cannot decorate the
      # response after the fact. The Rails controller passes a lambda and
      # identity carries the served-View fingerprint as `appVersion` — the
      # marker that moves for a View-only change, which schemaVersion is
      # blind to. Re-derived per call, same "derive, do not declare" rule.
      @app_version = app_version
      @limiter = RateLimiter.new(DEFAULT_RATE_LIMITS.dup, -> { (Time.now.to_f * 1000).to_i })
      store.put_grant(
        "token" => token, "credentialId" => "cred_local", "agentName" => "local",
        "principal" => "owner", "scopes" => ["*"]
      )
      # Seed records (materialize server-managed read-only fields) — but only
      # into a store that is genuinely fresh. A durable store that already
      # holds a database refuses the seed: re-seeding on every boot would
      # resurrect seed records the user deleted.
      if store.wants_seed
        store.seed.each do |name, records|
          records.each { |raw| store.put_record(name, materialize(name, raw)) }
        end
      end
    end

    # Everything wrong with the app part's module/operation declarations.
    #
    # Parity oracle: `modelProblems` in adapters/adapter-core/src/describe.ts.
    def model_problems
      problems = []
      declared = @modules.map { |m| m["name"] }
      if @modules.empty?
        problems << "no modules declared: every entity and operation belongs to one, and the root screen lists them"
      end
      seen = {}
      @modules.each do |m|
        problems << "duplicate module \"#{m["name"]}\"" if seen[m["name"]]
        seen[m["name"]] = true
      end

      @entity_defs.each do |name, d|
        mod = d["module"]
        if mod.nil? || mod == ""
          problems << "entity \"#{name}\" declares no module"
        elsif !declared.include?(mod)
          problems << "entity \"#{name}\" names undeclared module \"#{mod}\""
        end
      end

      @operations.each do |o|
        mod = o["module"]
        if mod.nil? || mod == ""
          problems << "operation \"#{o["name"]}\" declares no module"
        elsif !declared.include?(mod)
          problems << "operation \"#{o["name"]}\" names undeclared module \"#{mod}\""
        end
        unless o["params"].is_a?(Hash)
          problems << "operation \"#{o["name"]}\" declares no typed params (declare {} if it takes none)"
        end
        entity = o["entity"]
        if !entity.nil?
          d = @entity_defs[entity]
          if d.nil?
            problems << "operation \"#{o["name"]}\" acts on unknown entity \"#{entity}\""
          else
            if d["module"] != mod
              problems << "operation \"#{o["name"]}\" is in module \"#{mod}\" but acts on entity " \
                          "\"#{entity}\" in module \"#{d["module"]}\""
            end
            when_p = o["appliesWhen"]
            if when_p
              names = d["fields"].map { |f| f["name"] }
              predicate_fields(when_p).each do |referenced|
                unless names.include?(referenced)
                  problems << "operation \"#{o["name"]}\" appliesWhen reads \"#{referenced}\", " \
                              "not a field of \"#{entity}\""
                end
              end
            end
          end
        elsif o["appliesWhen"]
          problems << "operation \"#{o["name"]}\" declares appliesWhen but no entity: " \
                      "there is no record to evaluate it against"
        end
      end
      problems
    end

    # -- schema helpers -----------------------------------------------------
    def fields_of(entity)
      d = @entity_defs[entity]
      d ? d["fields"] : nil
    end

    def materialize(entity, body)
      fields = fields_of(entity) || []
      rec_id = body["id"].is_a?(String) && body["id"] != "" ? body["id"] : "rec_" + SecureRandom.hex(8)
      rec = { "id" => rec_id }
      fields.each do |f|
        if body.key?(f["name"]) && !body[f["name"]].nil? && body[f["name"]] != ""
          rec[f["name"]] = coerce(f, body[f["name"]])
        elsif f["readOnly"] && f["name"] == "created"
          rec[f["name"]] = now_iso
        end
      end
      rec
    end

    def schema_version
      prints = @entity_defs.to_h do |n, d|
        [n, { "fields" => d["fields"], "auth" => !!d["auth"], "module" => d["module"] }]
      end
      schema_fingerprint(prints, @operations)
    end

    # -- envelopes ----------------------------------------------------------
    def err(status, code, message, extra = {})
      [status, { "a2app" => true, "ok" => false, "code" => code, "message" => message }.merge(extra)]
    end
    private :err

    # -- identity / describe ------------------------------------------------
    def identity
      doc = {
        "a2app" => true, "protocol" => PROTOCOL_VERSION, "adapterVersion" => ADAPTER_VERSION,
        "app" => { "id" => @app_id, "name" => @app_name }, "schemaVersion" => schema_version,
        "serverNow" => now_iso, "serverTzOffsetMinutes" => 0,
      }
      # See the constructor: the wiring's fingerprint of the served View, so an
      # open tab's update watcher can tell a code change from a data change.
      doc["appVersion"] = @app_version.call if @app_version
      doc["env"] = @env if @env
      doc
    end

    # -- navigational describe (A2APP-SPEC 3) -------------------------------
    # One request answers for one place in the app, never for the whole app.
    # Parity oracle: adapters/adapter-core/src/describe.ts.

    def field_doc(f)
      field = { "type" => f["type"] }
      field["required"] = true if f["required"]
      field["readOnly"] = true if f["readOnly"]
      field["max"] = f["max"] unless f["max"].nil?
      field["values"] = f["values"] if f["values"]
      field["entity"] = f["entity"] if f["entity"]
      field["format"] = "YYYY-MM-DD" if f["dayKey"]
      field
    end

    # Everything except write-only.
    #
    # Load-bearing beyond describe: a client treats a field absent here as
    # write-only and exempts it from the read-back check, so dropping anything
    # else would quietly disable that backstop.
    def readable_fields(d)
      d["fields"].reject { |f| f["writeOnly"] }
    end

    # Trim a list until the level fits, always reporting what was dropped.
    # The budget is measured on the compact JSON Rails actually sends (the
    # python oracle measures a spaced rendering, which only over-estimates —
    # the ≤2000-char contract holds either way).
    def fit_list(items, &build)
      whole = build.call(items.dup, 0)
      return whole if JSON.generate(whole).length <= DESCRIBE_BUDGET_CHARS
      lo = 0
      hi = items.length
      while lo < hi
        mid = (lo + hi + 1) / 2
        if JSON.generate(build.call(items[0, mid], items.length - mid)).length <= DESCRIBE_BUDGET_CHARS
          lo = mid
        else
          hi = mid - 1
        end
      end
      build.call(items[0, lo], items.length - lo)
    end

    def entities_of(mod)
      @entity_defs.select { |_n, d| d["module"] == mod }.to_a
    end

    def describe_root(access)
      modules = @modules.map do |m|
        owned = entities_of(m["name"])
        ops = @operations.select { |o| o["module"] == m["name"] }
        readable = owned.count { |n, _d| access["read"].call(n) }
        writable = owned.count { |n, _d| access["write"].call(n) }
        runnable = ops.count { |o| access["run"].call(o["name"]) }
        reach =
          if owned.empty?
            runnable.zero? ? "none" : "full"
          elsif readable.zero? && runnable.zero?
            "none"
          elsif writable == owned.length && runnable == ops.length
            "full"
          else
            "read-only"
          end
        row = { "name" => m["name"], "entities" => owned.length, "operations" => ops.length, "access" => reach }
        row["summary"] = m["summary"] if m["summary"]
        row
      end
      {
        "level" => "root",
        "app" => { "id" => @app_id, "name" => @app_name },
        "modules" => modules,
        "conventions" => self.class.conventions,
        "next" => ["describe/{module}", "describe?find={term}"],
      }
    end

    def describe_module(mod, access, show_all)
      owned = []
      entities_of(mod["name"]).each do |name, d|
        next unless access["read"].call(name)
        row = { "name" => name }
        row["summary"] = d["summary"] if d["summary"]
        owned << row
      end
      ops = []
      @operations.each do |o|
        next if o["module"] != mod["name"] || !o["entity"].nil?
        next unless access["run"].call(o["name"])
        row = { "name" => o["name"], "destructive" => !!o["destructive"] }
        row["summary"] = o["description"] if o["description"]
        ops << row
      end

      base_next = ["describe/#{mod["name"]}/{entity}"]
      base_next << "#{mod["name"]} <operation> [--params]" unless ops.empty?

      build = lambda do |entity_rows, truncated|
        level = {
          "level" => "module",
          "path" => mod["name"],
          "entities" => entity_rows,
          "operations" => ops,
          "next" => base_next + (truncated.positive? ? ["describe/#{mod["name"]}?all=true"] : []),
        }
        level["summary"] = mod["summary"] if mod["summary"]
        level["truncated"] = truncated if truncated.positive?
        level
      end

      show_all ? build.call(owned, 0) : fit_list(owned, &build)
    end

    def describe_entity(mod, name, d, access)
      fields = readable_fields(d).to_h { |f| [f["name"], field_doc(f)] }
      ops = []
      @operations.each do |o|
        next if o["entity"] != name || !access["run"].call(o["name"])
        decl = { "name" => o["name"], "destructive" => !!o["destructive"], "params" => o["params"] || {} }
        decl["description"] = o["description"] if o["description"]
        decl["readOnly"] = true if o["readOnly"]
        decl["idempotent"] = true if o["idempotent"]
        decl["entity"] = name
        ops << decl
      end
      level = {
        "level" => "entity",
        "path" => "#{mod}/#{name}",
        "label" => label_field_of(d["fields"]),
        "records" => "/api/collections/#{name}/records",
        "fields" => fields,
        "operations" => ops,
        "next" => ["describe/#{mod}/#{name}/{id}", "data #{name} list"],
      }
      level["auth"] = true if d["auth"]
      level
    end

    def describe_record(mod, name, d, record, access)
      fields = readable_fields(d)
      label_field = label_field_of(d["fields"])
      label = label_field ? record[label_field] : nil

      ops = []
      @operations.each do |o|
        next if o["entity"] != name || !access["run"].call(o["name"])
        row = { "name" => o["name"], "available" => true }
        row["destructive"] = true if o["destructive"]
        when_p = o["appliesWhen"]
        if when_p && !evaluate_predicate(when_p, record, fields)
          row["available"] = false
          row["blocked"] = explain_predicate(when_p, record, fields)
        end
        ops << row
      end

      # Sub-resources are the record's own list<ref> fields: a forward relation
      # is derivable from the type vocabulary alone, with no query grammar.
      relations = []
      fields.each do |f|
        next if f["type"] != "list<ref>" || !f["entity"]
        row = { "name" => f["name"], "entity" => f["entity"] }
        value = record[f["name"]]
        row["count"] = value.length if value.is_a?(Array)
        relations << row
      end

      path = "#{mod}/#{name}/#{record["id"]}"
      level = {
        "level" => "record",
        "path" => path,
        "id" => record["id"],
        "label" => label.is_a?(String) || label.nil? ? label : label.to_s,
        "operations" => ops,
        "next" => relations.map { |r| "describe/#{path}/#{r["name"]}" } +
                  ops.select { |o| o["available"] }.map { |o| "#{path} #{o["name"]}" } +
                  ["data #{name} get #{record["id"]}"],
      }
      level["relations"] = relations unless relations.empty?
      level
    end

    def describe_find(term, access)
      needle = term.downcase
      matches = []
      @modules.each do |m|
        matches << { "path" => m["name"], "level" => "module" } if m["name"].downcase.include?(needle)
      end
      @entity_defs.each do |name, d|
        if access["read"].call(name) && name.downcase.include?(needle)
          matches << { "path" => "#{d["module"]}/#{name}", "level" => "entity" }
        end
      end
      @operations.each do |o|
        next unless access["run"].call(o["name"]) && o["name"].downcase.include?(needle)
        path = o["entity"] ? "#{o["module"]}/#{o["entity"]}" : (o["module"] || "")
        matches << { "path" => path, "operation" => o["name"] }
      end

      fit_list(matches) do |items, truncated|
        level = { "level" => "find", "term" => term, "matches" => items, "next" => ["describe/{path}"] }
        level["truncated"] = truncated if truncated.positive?
        level
      end
    end

    def self.conventions
      {
        "writes" => "Prefer a declared operation over a raw write where one exists.",
        "labels" => "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
        "dates" => 'Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.',
        "honesty" => "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
      }
    end

    # -- IAM ----------------------------------------------------------------
    def expand_scopes(grant)
      return grant["scopes"].to_a unless grant["scopes"].include?("*")
      scopes = []
      @entity_defs.each_key do |name|
        scopes << "data:#{name}:read"
        scopes << "data:#{name}:write"
      end
      @operations.each { |o| scopes << "op:#{o["name"]}" }
      scopes
    end

    def credential_of(headers)
      token = headers["x-a2app-token"] || headers["x-lui-token"]
      token ? @store.grant_by_token(token) : nil
    end

    def authorize(headers, scope, is_write)
      origin = headers["origin"]
      if !origin.nil? && !@allowed_origins.key?(origin)
        return [nil, err(403, "forbidden_origin", "Refused: request Origin is not this app's own.")]
      end
      if !origin.nil? && @allowed_origins.key?(origin)
        return [{ "credentialId" => "ui", "agentName" => nil, "principal" => "owner" }, nil]
      end
      grant = credential_of(headers)
      required = is_write || @auth_mode == "multi-user"
      if grant.nil?
        if required
          return [nil, err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], "This write requires an agent credential.",
                           "how" => @credential_hint)]
        end
        return [{ "credentialId" => "anonymous", "agentName" => nil, "principal" => "owner" }, nil]
      end
      if scope && !expand_scopes(grant).include?(scope)
        return [nil, err(403, ERROR_CODES["INSUFFICIENT_SCOPE"], "This credential does not hold #{scope}.",
                         "required" => scope)]
      end
      [{ "credentialId" => grant["credentialId"], "agentName" => grant["agentName"],
         "principal" => grant["principal"] }, nil]
    end

    def rate_gate(headers, cls)
      caller_id = headers["x-a2app-token"] || (headers["origin"] ? "origin:" + headers["origin"] : "anon")
      decision = @limiter.check(caller_id, cls)
      return nil if decision["allowed"]
      err(429, ERROR_CODES["RATE_LIMITED"],
          "Rate limit exceeded (#{decision["limit"]} per window). Slow down and retry.",
          "retryAfterSeconds" => decision["retryAfterSeconds"])
    end

    # True when the request carries one of the app's OWN origins — the trusted
    # browser-UI path `authorize` also honours.
    def is_same_origin(headers)
      origin = headers["origin"]
      !origin.nil? && @allowed_origins.key?(origin)
    end

    # -- dispatch -----------------------------------------------------------

    # What this caller may do, for rendering access on a describe level.
    #
    # Mirrors `authorize`'s precedence including its two bypasses — the app's
    # own UI and an anonymous read on a single-user app both reach a context
    # without meeting the scope check, so both genuinely have full access.
    def access_for(headers)
      if is_same_origin(headers)
        return { "read" => ->(_e) { true }, "write" => ->(_e) { true }, "run" => ->(_o) { true } }
      end
      grant = credential_of(headers)
      unless grant
        allow = @auth_mode != "multi-user"
        return { "read" => ->(_e) { allow }, "write" => ->(_e) { allow }, "run" => ->(_o) { allow } }
      end
      held = expand_scopes(grant)
      {
        "read" => ->(e) { held.include?("data:#{e}:read") },
        "write" => ->(e) { held.include?("data:#{e}:write") },
        "run" => ->(o) { held.include?("op:#{o}") },
      }
    end

    # Serve one level of describe.
    #
    # The record and relation levels read real records, which makes them data
    # reads: they take the same scope and rate class as the records API.
    # Without that, describe would be an unmetered path around the scope model.
    def handle_describe(headers, segments, q)
      access = access_for(headers)

      find = q["find"]
      if !find.nil? && segments.empty?
        return err(400, "usage", "find needs a term: describe?find={term}") if find == ""
        return [200, describe_find(find, access)]
      end

      return [200, describe_root(access)] if segments.empty?

      module_name = segments[0]
      mod = @modules.find { |m| m["name"] == module_name }
      if mod.nil?
        return err(404, "unknown_module", "No module \"#{module_name}\".",
                   "modules" => @modules.map { |m| m["name"] })
      end
      return [200, describe_module(mod, access, q["all"] == "true")] if segments.length == 1

      entity = segments[1]
      d = @entity_defs[entity]
      return err(404, "unknown_entity", "No such entity \"#{entity}\".") if d.nil?
      if d["module"] != module_name
        return err(404, "unknown_entity",
                   "Entity \"#{entity}\" is in module \"#{d["module"]}\", not \"#{module_name}\".")
      end
      if segments.length == 2
        unless access["read"].call(entity)
          return err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                     "This credential does not hold data:#{entity}:read.",
                     "required" => "data:#{entity}:read")
        end
        return [200, describe_entity(module_name, entity, d, access)]
      end

      limited = rate_gate(headers, "data")
      return limited if limited
      _ctx, reply = authorize(headers, "data:#{entity}:read", false)
      return reply if reply

      record_id = segments[2]
      record = @store.get_record(entity, record_id)
      return err(404, "record_not_found", "No #{entity} record \"#{record_id}\".") if record.nil?
      return [200, describe_record(module_name, entity, d, record, access)] if segments.length == 3

      relation = segments[3]
      field = d["fields"].find do |f|
        f["name"] == relation && f["type"] == "list<ref>" && f["entity"] && !f["writeOnly"]
      end
      return err(404, "unknown_relation", "\"#{relation}\" is not a sub-resource of #{entity}.") if field.nil?
      target = field["entity"]
      unless access["read"].call(target)
        return err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                   "This credential does not hold data:#{target}:read.",
                   "required" => "data:#{target}:read")
      end
      target_def = @entity_defs[target]
      target_label = target_def ? label_field_of(target_def["fields"]) : nil
      items = (record[relation] || []).map do |rid|
        referenced = @store.get_record(target, rid.to_s)
        label = referenced && target_label ? referenced[target_label] : nil
        { "id" => rid.to_s, "label" => label.is_a?(String) || label.nil? ? label : label.to_s }
      end

      path = "#{module_name}/#{entity}/#{record_id}/#{relation}"
      fit_list(items) do |rows, truncated|
        level = {
          "level" => "relation", "path" => path, "entity" => target, "items" => rows,
          "next" => ["data #{target} get {id}", "describe/#{module_name}/#{entity}/#{record_id}"],
        }
        level["truncated"] = truncated if truncated.positive?
        level
      end.then { |doc| [200, doc] }
    end

    def dispatch(method, path, headers, body, query = nil)
      headers = (headers || {}).to_h { |k, v| [k.to_s.downcase, v] }
      method = method.upcase
      q = (query || {}).dup
      if path.include?("?")
        path, qs = path.split("?", 2)
        # Last value wins, like python's parse_qs pick of v[-1].
        URI.decode_www_form(qs).each { |k, v| q[k] = v }
      end
      path = path.sub(%r{/+\z}, "")
      path = "/" if path.empty?

      return [200, identity] if ["/.well-known/a2app.json", "/api/_a2app"].include?(path)
      # Describe is navigational: the bare path is the root level, and each
      # extra segment moves one level inward (A2APP-SPEC 3).
      return handle_describe(headers, [], q) if path == "/api/_a2app/describe"
      if path.start_with?("/api/_a2app/describe/")
        segments = path["/api/_a2app/describe/".length..].split("/", -1).map { |s| unquote(s) }
        if segments.length > 4
          return err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.")
        end
        return err(404, "usage", "describe path has an empty segment.") if segments.any? { |s| s == "" }
        return handle_describe(headers, segments, q)
      end
      if path == "/api/_a2app/whoami"
        grant = credential_of(headers)
        return err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], "whoami requires a credential.") unless grant
        return [200, { "a2app" => true, "credentialId" => grant["credentialId"],
                       "agentName" => grant["agentName"], "principal" => grant["principal"],
                       "scopes" => expand_scopes(grant).sort }]
      end
      if path == "/api/_a2app/context"
        _ctx, reply = authorize(headers, nil, false)
        return reply if reply
        return [200, { "a2app" => true, "view" => nil, "selected" => [] }]
      end
      return handle_events(method, headers, q) if path == "/api/_a2app/events"
      if path == "/api/_a2app/tasks" || path.start_with?("/api/_a2app/tasks/")
        rest = path == "/api/_a2app/tasks" ? [] : path["/api/_a2app/tasks/".length..].split("/")
        return handle_tasks(method, headers, rest, body, q)
      end

      m = %r{\A/api/collections/([^/]+)/records(?:/([^/]+))?\z}.match(path)
      return handle_records(method, headers, m[1], m[2], body, q) if m

      m = %r{\A/api/ops/([^/]+)\z}.match(path)
      if m
        return err(405, "usage", "Operations are POST-only.") if method != "POST"
        return handle_operation(headers, m[1], body || {})
      end

      err(404, "not_found", "No such route.")
    end

    # -- records ------------------------------------------------------------

    # Who still points at this record.
    #
    # Every `ref` and `list<ref>` names the entity it targets, so the app has
    # ALREADY declared where its references live — this reads that rather than
    # asking for a second declaration.
    #
    # Pages through referencing entities instead of filtering in the store: a
    # filter grammar differs per backend, and a policy that silently did
    # nothing against one of them would be worse than no policy. Only entities
    # that actually declare a `restrict` ref to this one are read, so an entity
    # nothing points at costs nothing.
    def references_to(entity, rec_id)
      blockers = []
      @entity_defs.each do |other, d|
        pointing = d["fields"].select do |f|
          ["ref", "list<ref>"].include?(f["type"]) &&
            f["entity"] == entity &&
            (f["onDelete"] || DEFAULT_ON_DELETE) == "restrict"
        end
        next if pointing.empty?

        found = {}
        page = 1
        loop do
          result = @store.list_records(other, { "page" => page, "perPage" => REFERENCE_SCAN_PAGE })
          items = result["items"] || []
          items.each do |row|
            pointing.each do |f|
              value = row[f["name"]]
              hit = value.is_a?(Array) ? value.include?(rec_id) : value == rec_id
              next unless hit
              ids = (found[f["name"]] ||= [])
              ids << (row["id"] || "").to_s if ids.length < REFERENCE_SCAN_LIMIT
            end
          end
          break if items.length < REFERENCE_SCAN_PAGE
          page += 1
          break if page > REFERENCE_SCAN_MAX_PAGES
        end

        found.each do |field, ids|
          blockers << { "entity" => other, "field" => field, "ids" => ids }
        end
      end
      blockers
    end

    def handle_records(method, headers, entity, rec_id, body, query)
      limited = rate_gate(headers, "data")
      return limited if limited
      d = @entity_defs[entity]
      return err(404, "unknown_entity", "No such entity \"#{entity}\".") unless d
      fields = d["fields"]
      server_now = now_iso

      if method == "GET"
        _ctx, reply = authorize(headers, "data:#{entity}:read", false)
        return reply if reply
        if rec_id
          rec = @store.get_record(entity, rec_id)
          return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".") unless rec
          return [200, rec]
        end
        begin
          return [200, @store.list_records(entity, query)]
        rescue UnsupportedFilter => e
          # Refuse, never ignore: unfiltered rows under a filter would be a
          # 200 with the wrong records (see the grammar's comment).
          return err(400, "invalid_filter", e.message)
        end
      end

      ctx, reply = authorize(headers, "data:#{entity}:write", true)
      return reply if reply
      body ||= {}

      if method == "DELETE"
        return err(400, "usage", "DELETE requires a record id.") unless rec_id

        # The app's referential rules bind THIS door too.
        #
        # An app that guards deletion inside an operation has guarded one way
        # in: its own UI. This generic record route is the other, and it used
        # to go straight to the store — so the rule held right up until an
        # agent took the path the rule did not cover, and the orphan it left
        # was reported as a successful delete. The check belongs here, in
        # adapter code an app author cannot edit, because this is the only
        # place both doors pass through.
        blockers = references_to(entity, rec_id)
        unless blockers.empty?
          total = blockers.sum { |b| b["ids"].length }
          where = blockers.map { |b| "#{b["entity"]}.#{b["field"]}" }.join(", ")
          said = total == 1 ? "a record still references" : "#{total} records still reference"
          return err(
            409,
            ERROR_CODES["RECORD_REFERENCED"],
            "Cannot delete #{entity} \"#{rec_id}\": #{said} it (#{where}).",
            "referencedBy" => blockers,
            "resolution" =>
              "Remove or repoint the referencing records first, or run an operation the app " \
              "provides for this. An app that intends references to outlive the record " \
              'declares `onDelete: "ignore"` on the ref.'
          )
        end

        ok = @store.delete_record(entity, rec_id)
        return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".") unless ok
        return [200, { "a2app" => true, "ok" => true, "deleted" => rec_id }]
      end

      return err(405, "usage", "#{method} not allowed on records.") unless %w[POST PATCH].include?(method)

      idem = headers["idempotency-key"]
      if idem && method == "POST"
        prior = @store.idem_get(entity, idem)
        if prior
          return err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key already produced a record.",
                     "id" => prior)
        end
      end

      allow = (d["writeAllow"] || []).to_h { |k| [k, true] }
      violations = validate(fields, body, allow)
      unless violations.empty?
        first = violations[0]
        return [400, {
          "a2app" => true, "ok" => false, "code" => first["code"], "field" => first["field"],
          "expected" => first["expected"], "got" => first["got"],
          "message" => describe_violation(first, server_now),
          "violations" => violations.map do |v|
            { "code" => v["code"], "field" => v["field"], "expected" => v["expected"], "got" => v["got"] }
          end,
        }]
      end

      if method == "POST"
        stored = materialize(entity, body)
        @store.put_record(entity, stored)
      else
        return err(400, "usage", "PATCH requires a record id.") unless rec_id
        existing = @store.get_record(entity, rec_id)
        return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".") unless existing
        fields.each do |f|
          next if f["readOnly"] || !body.key?(f["name"])
          v = body[f["name"]]
          if v.nil? || v == ""
            existing.delete(f["name"])
          else
            existing[f["name"]] = coerce(f, v)
          end
        end
        @store.put_record(entity, existing)
        stored = existing
      end

      lost = divergences(fields, body, ->(n) { stored[n] })
      unless lost.empty?
        return [422, {
          "a2app" => true, "ok" => false, "code" => ERROR_CODES["NOT_STORED"],
          "message" => describe_incomplete(lost),
          "violations" => lost.map { |l| { "code" => ERROR_CODES["NOT_STORED"], "field" => l["field"] } },
          "id" => stored["id"],
        }]
      end

      @store.idem_put(entity, idem, stored["id"]) if idem && method == "POST"
      [200, stored]
    end

    # -- operations ---------------------------------------------------------
    def handle_operation(headers, name, args)
      limited = rate_gate(headers, "ops")
      return limited if limited
      decl = @op_by_name[name]
      return err(404, "unknown_operation", "No declared operation \"#{name}\".") unless decl
      ctx, reply = authorize(headers, "op:#{name}", !decl["readOnly"])
      return reply if reply

      if decl["destructive"]
        key = approval_key(name, args)
        provided = headers["x-a2app-approval"] || headers["x-lui-approval"]
        if provided.nil?
          @store.approval_issue(key)
          return err(428, ERROR_CODES["APPROVAL_REQUIRED"],
                     "Operation \"#{name}\" is destructive and requires approval.", "approvalKey" => key)
        end
        if provided != key || !@store.approval_consume(key)
          return err(428, ERROR_CODES["APPROVAL_REQUIRED"],
                     "Approval key does not match this exact call (or has expired).", "approvalKey" => key)
        end
      end

      runner = @runners[name]
      unless runner
        return err(501, "not_implemented", "This app declares \"#{name}\" but implements no operation runner.")
      end
      begin
        result = runner.call(args, ctx, @store)
        [200, { "a2app" => true, "ok" => true, "operation" => name, "result" => result }]
      rescue StandardError => e
        err(500, "operation_failed", "Operation \"#{name}\" threw: #{e.message}")
      end
    end

    # -- tasks / events -----------------------------------------------------
    def handle_events(_method, headers, query)
      limited = rate_gate(headers, "data")
      return limited if limited
      _ctx, reply = authorize(headers, nil, false)
      return reply if reply
      res = @store.events_since(query["since"])
      [200, {
        "a2app" => true,
        "events" => res["events"].map do |e|
          { "id" => e["id"], "app" => e["app"], "type" => e["type"], "payload" => e["payload"],
            "createdAt" => e["createdAt"] }
        end,
        "nextCursor" => res["nextCursor"], "pollAfterMs" => 3000,
      }]
    end

    def handle_tasks(method, headers, rest, body, query)
      limited = rate_gate(headers, "data")
      return limited if limited
      ctx, reply = authorize(headers, nil, method != "GET")
      return reply if reply

      if rest.empty? && method == "GET"
        status = query["status"]
        return [200, { "a2app" => true,
                       "tasks" => @store.list_tasks(status).map { |t| self.class.task_wire(t) },
                       "pollAfterMs" => 2000 }]
      end
      task_id = rest[0]
      return err(400, "usage", "Task id required.") unless task_id
      action = rest.length > 1 ? rest[1] : nil
      task = @store.get_task(task_id)
      return err(404, ERROR_CODES["TASK_NOT_FOUND"], "No task \"#{task_id}\".") unless task
      return [200, self.class.task_wire(task)] if action.nil? && method == "GET"
      return err(405, "usage", "#{method} not allowed here.") if method != "POST"
      body ||= {}

      case action
      when "claim"
        if task["status"] != "submitted"
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} is #{task["status"]}, not claimable.")
        end
        task["status"] = "working"
        task["claim"] = { "credentialId" => ctx["credentialId"], "principal" => ctx["principal"],
                          "claimedAt" => now_iso }
        @store.save_task(task)
        [200, self.class.task_wire(task)]
      when "progress"
        return err(409, ERROR_CODES["TASK_CANCELED"], "Task #{task_id} was canceled.") if task["status"] == "canceled"
        unless %w[working input-required].include?(task["status"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} is #{task["status"]}.")
        end
        task["progress"]["step"] = body["step"] if body["step"].is_a?(String)
        task["progress"]["percent"] = body["percent"] if body["percent"].is_a?(Numeric)
        if !body["ask"].nil?
          task["ask"] = body["ask"]
          task["status"] = "input-required"
        elsif task["status"] == "input-required"
          task["status"] = "working"
        end
        @store.save_task(task)
        [200, self.class.task_wire(task)]
      when "complete"
        return err(409, ERROR_CODES["TASK_CANCELED"], "Task #{task_id} was canceled.") if task["status"] == "canceled"
        status = body["status"]
        if status == "completed"
          task["status"] = "completed"
          task["result"] = body["result"] || {}
        elsif status == "failed"
          task["status"] = "failed"
          task["reason"] = body["reason"].is_a?(String) ? body["reason"] : "unspecified"
        else
          return err(400, "usage", 'complete requires status "completed" or "failed".')
        end
        @store.save_task(task)
        [200, self.class.task_wire(task)]
      when "cancel"
        task["status"] = "canceled"
        @store.save_task(task)
        [200, self.class.task_wire(task)]
      else
        err(404, "usage", "Unknown task action \"#{action}\".")
      end
    end

    def self.task_wire(t)
      {
        "id" => t["id"], "app" => t["app"], "event" => t["event"], "status" => t["status"],
        "request" => t["request"], "claim" => t["claim"], "progress" => t["progress"],
        "result" => t["result"], "reason" => t["reason"], "createdAt" => t["createdAt"],
        "updatedAt" => t["updatedAt"], "pollAfterMs" => 2000,
      }
    end

    # -- app -> agent -------------------------------------------------------
    def trigger(etype, payload, capability = nil)
      ev = @store.append_event(etype, payload)
      task_id = nil
      task_id = @store.enqueue_task(ev["id"], capability, payload)["id"] if capability
      { "eventId" => ev["id"], "taskId" => task_id }
    end
  end

  # -------------------------------------------------------------- self-test
  # Rules-parity oracle, run by the toolkit gate (`ruby lib/a2app_adapter.rb
  # --selftest`). Its job is to prove this port, the python oracle and
  # `@a2app/rules` agree, so a Rails app and a Node app reject identical
  # payloads identically and block identical operations for identical stated
  # reasons. Every check and every expected value below is ported from the
  # python blueprint's selftest — do not "improve" an expectation here without
  # moving the oracle first.
  def self.selftest
    failures = []

    check = lambda do |label, actual, expected|
      if actual != expected
        failures << "#{label}\n    expected: #{expected.inspect}\n    actual:   #{actual.inspect}"
      end
    end

    fields = [
      { "name" => "title", "type" => "string", "required" => true, "max" => 200 },
      { "name" => "status", "type" => "enum", "values" => ["todo", "doing", "done"] },
      { "name" => "due", "type" => "string", "max" => 10, "dayKey" => true },
      { "name" => "created", "type" => "datetime", "readOnly" => true },
    ]

    # 1. Guard: every violation, by code, sorted.
    bad = { "nope" => 1, "created" => "x", "status" => "nonsense", "due" => "31-12-2026" }
    check.call(
      "guard reports every violation",
      Rules.validate(fields, bad).map { |v| v["code"] }.sort,
      ["invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"]
    )
    check.call("a good body yields no violations",
               Rules.validate(fields, { "title" => "ok", "status" => "todo" }), [])
    check.call("label field resolution", Rules.label_field_of(fields), "title")

    # 2. Predicates: availability AND the stated reason. Both are contractual —
    #    a blocked operation must say the same thing on every stack.
    record = { "id" => "t1", "title" => "Ship it", "status" => "doing" }
    check.call("ne holds", Rules.evaluate_predicate({ "field" => "status", "ne" => "done" }, record, fields), true)
    check.call("eq fails", Rules.evaluate_predicate({ "field" => "status", "eq" => "done" }, record, fields), false)
    check.call(
      "eq explains with both values",
      Rules.explain_predicate({ "field" => "status", "eq" => "done" }, record, fields),
      'status is "doing", not "done"'
    )
    check.call(
      "in explains with the full set",
      Rules.explain_predicate({ "field" => "status", "in" => ["todo", "done"] }, record, fields),
      'status is "doing", not "todo" or "done"'
    )
    check.call(
      "all reports the first failing branch",
      Rules.explain_predicate(
        { "all" => [{ "field" => "status", "ne" => "done" }, { "field" => "title", "eq" => "Other" }] },
        record, fields
      ),
      'title is "Ship it", not "Other"'
    )
    check.call("isBlank on an absent field",
               Rules.evaluate_predicate({ "field" => "due", "isBlank" => true }, record, fields), true)
    # A backend may store a boolean as text; both are the same boolean.
    bool_fields = [{ "name" => "done", "type" => "boolean" }]
    check.call(
      "boolean compares by declared type, not storage shape",
      Rules.evaluate_predicate({ "field" => "done", "eq" => true }, { "id" => "x", "done" => "true" }, bool_fields),
      true
    )
    # An unrecognised form must refuse, never default to available.
    check.call("unknown predicate form refuses",
               Rules.evaluate_predicate({ "field" => "status" }, record, fields), false)

    # 3. Fingerprint: stable, and moved by anything describe publishes.
    base = { "tasks" => { "fields" => fields, "module" => "planning" } }
    check.call("fingerprint is deterministic", Rules.schema_fingerprint(base), Rules.schema_fingerprint(base))
    moved = { "tasks" => { "fields" => fields, "module" => "other" } }
    failures << "fingerprint ignores an entity's module" if Rules.schema_fingerprint(base) == Rules.schema_fingerprint(moved)
    if Rules.schema_fingerprint(base, [{ "name" => "op", "params" => {} }]) ==
       Rules.schema_fingerprint(base, [{ "name" => "op", "params" => { "x" => { "type" => "string" } } }])
      failures << "fingerprint ignores operation params"
    end

    # 4. Referential deletes: the rule an app declares with a `ref` binds the
    #    generic record route, not just whatever operation the app wrote. This
    #    checks the scan itself — the thing a delete consults before it commits.
    fake_store = Class.new do
      def initialize(rows)
        @rows = rows
      end

      def list_records(entity, query)
        items = (@rows[entity] || {}).values
        per_page = Integer(query["perPage"] || (items.empty? ? 1 : items.length))
        page = Integer(query["page"] || 1)
        start = (page - 1) * per_page
        { "items" => items[start, per_page] || [], "totalItems" => items.length }
      end
    end

    make_adapter = lambda do |entity_defs, store|
      ad = Adapter.allocate
      ad.instance_variable_set(:@entity_defs, entity_defs)
      ad.instance_variable_set(:@store, store)
      ad
    end

    invoice_fields = [
      { "name" => "client", "type" => "ref", "entity" => "clients" },
      { "name" => "projects", "type" => "list<ref>", "entity" => "projects" },
    ]
    defs = {
      "clients" => { "fields" => [{ "name" => "name", "type" => "string" }], "module" => "sales" },
      "projects" => { "fields" => [{ "name" => "title", "type" => "string" }], "module" => "sales" },
      "invoices" => { "fields" => invoice_fields, "module" => "sales" },
    }
    store = fake_store.new(
      "clients" => { "c_acme" => { "id" => "c_acme" }, "c_unused" => { "id" => "c_unused" } },
      "projects" => { "p_one" => { "id" => "p_one" } },
      "invoices" => { "inv_1" => { "id" => "inv_1", "client" => "c_acme", "projects" => ["p_one"] } }
    )
    ad = make_adapter.call(defs, store)

    check.call(
      "a referenced record reports who blocks it",
      ad.references_to("clients", "c_acme"),
      [{ "entity" => "invoices", "field" => "client", "ids" => ["inv_1"] }]
    )
    check.call("an unreferenced record blocks nothing", ad.references_to("clients", "c_unused"), [])
    check.call(
      "a reference held in a list counts too",
      ad.references_to("projects", "p_one"),
      [{ "entity" => "invoices", "field" => "projects", "ids" => ["inv_1"] }]
    )

    # The opt-out is per field, and it is the only way to allow orphaning.
    ignoring = defs.merge(
      "invoices" => { "fields" => [
        { "name" => "client", "type" => "ref", "entity" => "clients", "onDelete" => "ignore" },
        invoice_fields[1],
      ], "module" => "sales" }
    )
    check.call(
      'onDelete "ignore" removes the block',
      make_adapter.call(ignoring, store).references_to("clients", "c_acme"),
      []
    )
    check.call(
      "and leaves the other ref guarded",
      make_adapter.call(ignoring, store).references_to("projects", "p_one"),
      [{ "entity" => "invoices", "field" => "projects", "ids" => ["inv_1"] }]
    )

    # 5. Filter grammar: filtered reads filter, and anything outside the
    #    grammar is refused, never ignored.
    flt_store = Store.new
    flt_store.put_record("tasks", { "id" => "a", "title" => "Ship it", "status" => "todo" })
    flt_store.put_record("tasks", { "id" => "b", "title" => "Other work", "status" => "done" })
    check.call(
      "filter: equality",
      flt_store.list_records("tasks", { "filter" => 'status = "todo"' })["items"].map { |r| r["id"] },
      ["a"]
    )
    check.call(
      "filter: negation",
      flt_store.list_records("tasks", { "filter" => 'status != "todo"' })["items"].map { |r| r["id"] },
      ["b"]
    )
    check.call(
      "filter: contains",
      flt_store.list_records("tasks", { "filter" => 'title ~ "Ship"' })["items"].map { |r| r["id"] },
      ["a"]
    )
    begin
      flt_store.list_records("tasks", { "filter" => 'status = "todo" && title ~ "x"' })
      failures << "an unsupported filter expression was silently accepted"
    rescue UnsupportedFilter
      # refused, as required
    end

    # 6. SQLite store: durable records + idempotency keys, and seed-once
    #    semantics across a restart (reopening the same file). This section
    #    REQUIRES the sqlite3 gem; a missing gem is a failure with the install
    #    message, never a silently skipped check.
    begin
      require "tmpdir"
      Dir.mktmpdir("a2app-selftest-") do |tmp|
        db_path = File.join(tmp, "data", "db.sqlite")
        first = SqliteStore.new(db_path)
        check.call("a fresh database file wants the seed", first.wants_seed, true)
        first.put_record("tasks", { "id" => "t1", "title" => "persisted", "status" => "todo" })
        first.idem_put("tasks", "key-1", "t1")
        check.call("sqlite get returns what was put", first.get_record("tasks", "t1")["title"], "persisted")
        check.call(
          "sqlite list flows through the shared filter/sort/page",
          first.list_records("tasks", { "filter" => 'status = "todo"' })["items"].map { |r| r["id"] },
          ["t1"]
        )
        first.close

        second = SqliteStore.new(db_path)
        check.call("an existing database refuses the seed", second.wants_seed, false)
        check.call("records survive a restart", second.get_record("tasks", "t1")["title"], "persisted")
        check.call("idempotency keys survive a restart", second.idem_get("tasks", "key-1"), "t1")
        check.call("delete removes the row", second.delete_record("tasks", "t1"), true)
        check.call("a second delete reports not-found", second.delete_record("tasks", "t1"), false)
        second.close
      end
    rescue StandardError => e
      failures << "sqlite store: #{e.message}"
    end

    if failures.any?
      puts "a2app_adapter selftest FAILED:\n  - " + failures.join("\n  - ")
      return 1
    end
    puts "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store)"
    0
  end
end

if $PROGRAM_NAME == __FILE__
  if ARGV.include?("--selftest")
    exit A2appAdapter.selftest
  end
  puts "a2app_adapter is a library; Rails serves it (see config/routes.rb). Use --selftest to check rules parity."
end
