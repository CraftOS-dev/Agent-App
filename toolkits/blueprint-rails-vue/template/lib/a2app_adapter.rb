# A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).
#
# A faithful Ruby port of the A2App served surface: identity, describe, whoami,
# context, guarded records CRUD, declared operations (with approval for
# destructive ops), the app->agent task/event plane, and protocol 0.2's
# principals (spec/v0_2/auth.md): accounts, sessions and invites on a
# multi-user app, delegated agent credentials held only as hashes, device-code
# sign-in, task credentials, record ownership, and the user ceiling. It
# enforces the fixed validation chain: origin -> credential -> scope -> guard
# -> backend -> read-back. Records and all adapter state (credentials,
# accounts, tasks, events, approvals, idempotency keys, the audit log)
# persist in SQLite (the `sqlite3` gem — see SqliteStore), so the live
# database is a real on-disk file inside the toolkit's declared lifecycle
# dataDir.
#
# The pure validation rules below MUST match `@a2app/rules`, and the served
# surface `@a2app/adapter-core` (adapters/adapter-core/src), so a Rails app and
# a Node app reject identical payloads identically — verified by the
# conformance suites. Rails wiring lives in app/controllers/a2app_controller.rb;
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
# stdlib, not gems: uri for the host and public-URL rules, fileutils for
# creating the data directory on first boot.
require "uri"
require "fileutils"
require "ipaddr"
# stdlib too: openssl for PBKDF2 and the constant-time compare, delegate for
# the store a runner is handed, monitor for the store's reentrant lock.
require "openssl"
require "delegate"
require "monitor"

module A2appAdapter
  # JavaScript's semantics, for the places where a value's meaning depends on
  # them: what counts as whitespace, what Number() makes of a string, how a
  # number prints, how long a string is, the order keys sort in, and RFC 8785
  # canonical JSON. A body, a query string or an approval key is read here
  # exactly as adapter-core reads it. Parity oracles: ECMA-262, and
  # adapters/adapter-core/src/canon.ts for the canonical form.
  module Js
    module_function

    # WhiteSpace and LineTerminator: what String#trim and Number() strip.
    SPACE = '[\t\n\x0B\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
    TRIM_RE = Regexp.new("\\A#{SPACE}+|#{SPACE}+\\z")
    DECIMAL_RE = /\A([+-]?)(?:(Infinity)|(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\z/
    RADIX_RE = /\A0(?:[xX](\h+)|[oO]([0-7]+)|[bB]([01]+))\z/
    # The largest integer a double holds exactly.
    SAFE_INTEGER = 2**53
    ESCAPES = { '"' => '\\"', "\\" => "\\\\", "\b" => "\\b", "\f" => "\\f", "\n" => "\\n", "\r" => "\\r", "\t" => "\\t" }.freeze

    # String#trim.
    def trim(s)
      s.gsub(TRIM_RE, "")
    end

    # String#length (UTF-16 code units), so a length limit holds at the same
    # character on every stack.
    def length(s)
      s.each_codepoint.sum { |c| c > 0xFFFF ? 2 : 1 }
    end

    # A string as UTF-16 code units, for comparing: JavaScript orders strings
    # by code unit, which puts U+FFFF after an emoji.
    def utf16(s)
      s.encode(Encoding::UTF_16BE, invalid: :replace, undef: :replace).b
    end

    # Number(string), as a Float (NaN where JavaScript gives NaN): "010" is
    # 10, "0x1A" 26, "1e3" 1000, "" 0, "1_0" and "inf" NaN.
    def number(s)
      t = trim(s.to_s)
      return 0.0 if t.empty?
      if (m = RADIX_RE.match(t))
        digits, base = m[1] ? [m[1], 16] : m[2] ? [m[2], 8] : [m[3], 2]
        return Integer(digits, base).to_f
      end
      m = DECIMAL_RE.match(t)
      return Float::NAN if m.nil?
      value = m[2] ? Float::INFINITY : "#{m[3] || "0"}.#{m[4] || m[5] || "0"}e#{m[6] || "0"}".to_f
      m[1] == "-" ? -value : value
    end

    # A number as JavaScript holds and serializes it: an integral value is an
    # Integer (1000, never 1000.0), anything else stays a Float.
    def number_value(n)
      return n if n.is_a?(Integer) && n.abs <= SAFE_INTEGER
      f = n.to_f
      f.finite? && f == f.truncate && f.abs < 1e21 ? Integer(number_to_s(f)) : f
    end

    # Number#toString: the shortest round-trip digits, laid out as ECMA-262
    # says (1e+21, 1e-7, 0.000001, 123456789012345680000).
    def number_to_s(n)
      return n.to_s if n.is_a?(Integer) && n.abs <= SAFE_INTEGER
      f = n.to_f
      return "NaN" if f.nan?
      return f.positive? ? "Infinity" : "-Infinity" if f.infinite?
      return "0" if f.zero?
      return "-#{number_to_s(-f)}" if f.negative?

      # Ruby prints the same shortest digits, as I.F[e±X]: the value is
      # 0.D × 10^point, D the digits without leading or trailing zeros.
      mantissa, exp = f.to_s.split("e")
      int, frac = mantissa.split(".")
      digits = int + frac.to_s
      point = int.length + exp.to_i
      stripped = digits.sub(/\A0+/, "")
      point -= digits.length - stripped.length
      digits = stripped.sub(/0+\z/, "")
      k = digits.length
      if k <= point && point <= 21
        digits + "0" * (point - k)
      elsif point.positive? && point <= 21
        "#{digits[0, point]}.#{digits[point..]}"
      elsif point > -6 && point <= 0
        "0.#{"0" * -point}#{digits}"
      else
        e = point - 1
        (k == 1 ? digits : "#{digits[0]}.#{digits[1..]}") + "e#{e.negative? ? "-" : "+"}#{e.abs}"
      end
    end

    # String(value).
    def string(v)
      case v
      when nil then "null"
      when true, false then v.to_s
      when Numeric then number_to_s(v)
      when Array then join(v, ",")
      when Hash then "[object Object]"
      else v.to_s
      end
    end

    # Array#join: a null element is empty.
    def join(values, separator)
      values.map { |v| v.nil? ? "" : string(v) }.join(separator)
    end

    # A value as JSON.stringify would write it: numbers as JavaScript prints
    # them, and a non-finite number (which JSON cannot carry) as null.
    def value(v)
      case v
      when Hash then v.to_h { |k, x| [k.to_s, value(x)] }
      when Array then v.map { |x| value(x) }
      when Float then v.finite? ? number_value(v) : nil
      when Integer then number_value(v)
      else v
      end
    end

    # JSON.stringify.
    def dump(v)
      JSON.generate(value(v))
    end

    # RFC 8785 canonical JSON (the JCS serialization adapter-core's approval
    # key and task dedup key are hashed over): keys sorted by UTF-16 code
    # unit, numbers in their shortest form, minimal string escaping.
    def canonicalize(v)
      case v
      when nil then "null"
      when true, false then v.to_s
      when Numeric
        raise ArgumentError, "cannot canonicalize a non-finite number" if v.is_a?(Float) && !v.finite?
        number_to_s(v)
      when String then canonical_string(v)
      when Array then "[#{v.map { |x| canonicalize(x) }.join(",")}]"
      when Hash
        pairs = v.map { |k, x| [k.to_s, x] }.sort_by { |k, _x| utf16(k) }
        "{#{pairs.map { |k, x| "#{canonical_string(k)}:#{canonicalize(x)}" }.join(",")}}"
      else
        raise ArgumentError, "cannot canonicalize value of type #{v.class}"
      end
    end

    def canonical_string(s)
      %("#{s.gsub(/["\\\x00-\x1f]/) { |c| ESCAPES[c] || format("\\u%04x", c.ord) }}")
    end

    # decodeURIComponent, but nil where JavaScript would throw (a stray `%`,
    # or bytes that are not UTF-8).
    def decode_uri_component(s)
      raw = s.b
      return nil if raw.match?(/%(?!\h\h)/n)
      decoded = raw.gsub(/%(\h\h)/n) { Regexp.last_match(1).hex.chr }.force_encoding(Encoding::UTF_8)
      decoded.valid_encoding? ? decoded : nil
    end

    # decodeURIComponent, raising where JavaScript throws: a path segment that
    # cannot be decoded is the adapter_error adapter-core answers.
    def decode_uri_component!(s)
      decode_uri_component(s) || raise(ArgumentError, "URI malformed")
    end

    # encodeURIComponent.
    def encode_uri_component(s)
      s.to_s.b.gsub(/[^A-Za-z0-9\-_.!~*'()]/n) { |c| format("%%%02X", c.ord) }
    end

    # A query string as URLSearchParams reads it: `+` is a space, a bad
    # escape stays as typed, and the last of a repeated name wins. No
    # brackets: `sort[]` is a name like any other.
    def parse_query(qs)
      qs.to_s.split("&").each_with_object({}) do |part, out|
        next if part.empty?
        name, value = part.split("=", 2)
        out[form_decode(name)] = form_decode(value.to_s)
      end
    end

    def form_decode(s)
      s.b.tr("+", " ").gsub(/%(\h\h)/n) { Regexp.last_match(1).hex.chr }.force_encoding(Encoding::UTF_8).scrub("\ufffd")
    end

    # Array#slice(from, to) for numbers that may be fractional, negative,
    # infinite or NaN — a page computed from `?page=0` or `?perPage=abc`
    # selects what it selects in JavaScript.
    def slice(items, from, to)
      first = slice_index(from, items.length)
      last = slice_index(to, items.length)
      last > first ? items[first...last] : []
    end

    def slice_index(n, len)
      f = n.to_f
      return 0 if f.nan?
      i = f.infinite? ? f : f.truncate
      (i.negative? ? [len + i, 0].max : [i, len].min).to_i
    end
  end


  # Where an app listens, and the address the rest of the world uses for it.
  # The one rule: a bearer token must never cross a network in clear, so
  # binding a non-loopback address needs an https public URL, and a public URL
  # may be plain http only when it names this machine (an SSH tunnel ends on
  # loopback). config/puma.rb binds with it; the controller passes the public
  # URL to the adapter.
  module Network
    module_function

    # Is `name` a loopback name or address? Accepts a bracketed IPv6 literal.
    def loopback_name?(name)
      bare = name.to_s.downcase.delete_prefix("[").delete_suffix("]")
      return true if bare == "localhost"
      IPAddr.new(bare).loopback?
    rescue IPAddr::Error
      false
    end

    # The host name in a Host value (`name`, `name:port`, `[v6]:port`), or nil.
    def hostname_of(host)
      URI.parse("http://#{host}").hostname&.downcase
    rescue URI::Error
      nil
    end

    # [bind host, public origin or nil] from A2APP_HOST / A2APP_PUBLIC_URL, or
    # ArgumentError with the reason the combination is unsafe.
    def policy(host_env, public_url_env)
      host = host_env.to_s.strip
      host = "127.0.0.1" if host.empty?
      public_url = nil
      scheme = ""
      raw = public_url_env.to_s.strip
      unless raw.empty?
        begin
          uri = URI.parse(raw)
        rescue URI::Error
          raise ArgumentError, %(A2APP_PUBLIC_URL is not a URL: "#{raw}".)
        end
        scheme = uri.scheme.to_s.downcase
        raise ArgumentError, %(A2APP_PUBLIC_URL is not a URL: "#{raw}".) if uri.host.nil?
        raise ArgumentError, %(A2APP_PUBLIC_URL must be an http(s) URL, not "#{raw}".) unless %w[http https].include?(scheme)
        if scheme == "http" && !loopback_name?(uri.hostname)
          raise ArgumentError, %(A2APP_PUBLIC_URL must be https: "#{raw}" would send the agent token across a network in clear. ) +
                               "Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address."
        end
        default_port = scheme == "https" ? 443 : 80
        public_url = "#{scheme}://#{uri.host.downcase}#{uri.port == default_port ? "" : ":#{uri.port}"}"
      end
      if !loopback_name?(host) && scheme != "https"
        raise ArgumentError, "A2APP_HOST=#{host} exposes the app to the network, so A2APP_PUBLIC_URL must name its https address " \
                             "(the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1."
      end
      [host, public_url]
    end
  end

  # The security primitives behind accounts, sessions, invites, device codes
  # and credentials (spec/v0_2/auth.md), kept apart from the served surface so
  # each rule — what a secret looks like, how it is stored, how a password is
  # checked — is written once. Parity oracle: adapter-core's auth.ts.
  #
  # Every secret the app hands out (tokens, session ids, invite codes, device
  # codes) is 256 random bits, returned once, and stored only as its SHA-256.
  # Passwords are PBKDF2-SHA256 at 600 000 iterations (OWASP), compared in
  # constant time, in the same `pbkdf2_sha256$…` format adapter-core writes.
  module Auth
    module_function

    PBKDF2_ITERATIONS = 600_000
    PBKDF2_KEY_BYTES = 32
    PBKDF2_SALT_BYTES = 16
    PASSWORD_MIN = 10
    PASSWORD_MAX = 256
    # Consonants only (RFC 8628 §6.1): no vowels, so no words; no look-alikes.
    USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"

    # 256 random bits, base64url (43 chars).
    def new_secret
      SecureRandom.urlsafe_base64(32)
    end

    # An agent credential token: `a2a_` + 256 random bits.
    def new_token
      "a2a_" + new_secret
    end

    # How a secret is stored and looked up: hex SHA-256 of the whole string.
    def hash_secret(secret)
      Digest::SHA256.hexdigest(secret)
    end

    # An id that is not a secret: `prefix_` + 64 random bits, hex.
    def new_id(prefix)
      "#{prefix}_#{SecureRandom.hex(8)}"
    end

    # `pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>`
    def hash_password(password, iterations = PBKDF2_ITERATIONS)
      salt = SecureRandom.random_bytes(PBKDF2_SALT_BYTES)
      key = OpenSSL::PKCS5.pbkdf2_hmac(password, salt, iterations, PBKDF2_KEY_BYTES, "sha256")
      "pbkdf2_sha256$#{iterations}$#{[salt].pack("m0")}$#{[key].pack("m0")}"
    end

    # Constant-time check of `password` against a stored hash. A malformed
    # hash never matches.
    def verify_password(password, stored)
      parts = stored.to_s.split("$", -1)
      return false unless parts.length == 4 && parts[0] == "pbkdf2_sha256" && parts[1].match?(/\A[1-9]\d*\z/)
      salt = parts[2].unpack1("m")
      expected = parts[3].unpack1("m")
      return false if expected.empty?
      actual = OpenSSL::PKCS5.pbkdf2_hmac(password, salt, parts[1].to_i, expected.bytesize, "sha256")
      OpenSSL.fixed_length_secure_compare(actual, expected)
    end

    # `XXXX-XXXX` from USER_CODE_ALPHABET.
    def new_user_code
      code = Array.new(8) { USER_CODE_ALPHABET[SecureRandom.random_number(USER_CODE_ALPHABET.length)] }.join
      "#{code[0, 4]}-#{code[4, 4]}"
    end

    # A user code as typed: case and the dash do not matter.
    def normalize_user_code(input)
      letters = input.to_s.upcase.each_char.select { |c| USER_CODE_ALPHABET.include?(c) }.join
      letters.length == 8 ? "#{letters[0, 4]}-#{letters[4, 4]}" : ""
    end

    # `Cookie` header -> name/value pairs (the first occurrence of a name wins).
    def parse_cookies(header)
      out = {}
      header.to_s.split(";").each do |part|
        eq = part.index("=")
        next if eq.nil? || eq <= 0
        name = part[0, eq].strip
        next if out.key?(name)
        value = Js.decode_uri_component(part[eq + 1..].strip)
        # nil: not a value this app wrote
        out[name] = value unless value.nil?
      end
      out
    end

    # A `Set-Cookie` value for the session cookie. `max_age_seconds: 0` clears it.
    def session_cookie(name, value, max_age_seconds:, secure:)
      attrs = ["#{name}=#{Js.encode_uri_component(value)}", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=#{max_age_seconds}"]
      attrs << "Secure" if secure
      attrs.join("; ")
    end

    # A login as stored and compared: trimmed, lower-cased.
    def normalize_login(login)
      Js.trim(login).downcase
    end

    # Counts failures per key in a fixed window (sign-in failures per login).
    # In memory: a restart forgets them, which costs an attacker nothing they
    # could not get by waiting out the window.
    class FailureLimiter
      def initialize(max, window_ms, now_ms)
        @max = max
        @window_ms = window_ms
        @now_ms = now_ms
        @windows = {}
        @lock = Mutex.new
      end

      # Seconds until `key` may try again, or 0 when it may now.
      def retry_after(key)
        @lock.synchronize do
          w = @windows[key]
          next 0 if w.nil?
          elapsed = @now_ms.call - w[:start]
          if elapsed >= @window_ms
            @windows.delete(key)
            next 0
          end
          w[:count] >= @max ? ((@window_ms - elapsed) / 1000.0).ceil : 0
        end
      end

      def fail(key)
        @lock.synchronize do
          t = @now_ms.call
          w = @windows[key]
          if w.nil? || t - w[:start] >= @window_ms
            @windows[key] = { count: 1, start: t }
          else
            w[:count] += 1
          end
        end
      end

      def reset(key)
        @lock.synchronize { @windows.delete(key) }
      end
    end
  end
end

module A2appAdapter
  RULES_VERSION = "0.1.0"
  PROTOCOL_VERSION = "0.2"
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
    "MISSING_REQUIRED" => "missing_required",
    "NOT_STORED" => "not_stored",
    "DUPLICATE_REQUEST" => "duplicate_request",
    "APPROVAL_REQUIRED" => "approval_required",
    "INSUFFICIENT_SCOPE" => "insufficient_scope",
    "AMBIGUOUS_REF" => "ambiguous_ref",
    "INVALID_FILTER" => "invalid_filter",
    "INVALID_EVENT" => "invalid_event",
    "TASK_NOT_FOUND" => "task_not_found",
    "TASK_NOT_CLAIMABLE" => "task_not_claimable",
    "TASK_CANCELED" => "task_canceled",
    # Progress or completion on a task whose claim another credential holds
    # (spec/v0_2/auth.md §6.3).
    "TASK_NOT_HELD" => "task_not_held",
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

  # A claimed task with no progress for this long is presumed abandoned and
  # goes back to the queue, so a dead agent's work is redelivered rather than
  # lost. Anything that delivers work from this queue (`agent-app <dir>
  # bridge`) heartbeats well inside it; the value matches adapter-core.
  TASK_TIMEOUT_MS = 60_000
  # Redelivery is bounded: a task handed out this many times without finishing
  # fails with `redelivery_exhausted` instead of cycling forever.
  TASK_MAX_DELIVERIES = 5

  DESCRIBE_BUDGET_CHARS = 2000

  DEFAULT_RATE_LIMITS = { "data" => 1200, "ops" => 300 }.freeze

  MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].freeze
  # A pattern ported from @a2app/rules reads `\s` as JavaScript does
  # (Js::SPACE); Ruby's `\d` and `\w` are ASCII, as JavaScript's are.
  DATE_RE = /\A(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?#{Js::SPACE}*(Z|[+-]\d{2}:?\d{2})?\z/
  DAY_RE = /\A(\d{4})-(\d{2})-(\d{2})\z/

  # The single-clause filter grammar this backend implements — `field = "value"`,
  # `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in
  # one pair of parentheses. Enough for label->id resolution; a richer backend
  # exposes its own query language. Anything outside it is REFUSED, never
  # ignored: a store that accepts `filter` and returns unfiltered rows answers
  # 200 with the wrong records, which turns every label lookup into a false
  # multi-match. Parity: the react-node blueprint's matchFilter in server.mjs.
  FILTER_RE = /\A#{Js::SPACE}*\(?#{Js::SPACE}*([A-Za-z_]\w*)#{Js::SPACE}*(=|!=|~)#{Js::SPACE}*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:(?!#{Js::SPACE})[^"'()])+))#{Js::SPACE}*\)?#{Js::SPACE}*\z/

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

    # A number, or a string Number() reads as one (not blank, not NaN).
    def number_like?(v)
      v.is_a?(Numeric) || (v.is_a?(String) && Js.trim(v) != "" && !Js.number(v).nan?)
    end

    # An enum member, compared as JavaScript's String() renders both sides.
    def enum_member?(values, v)
      values.any? { |allowed| Js.string(allowed) == Js.string(v) }
    end

    # Validate a RAW body against normalized fields; returns every violation
    # in the request. `allow` is extra keys accepted without being fields;
    # `require_required` is set only on a create, where a required field left
    # out is `missing_required` (a partial update may leave one out).
    #
    # Parity oracle: `validate` in adapters/rules/src/index.ts — the same
    # checks in the same order, each field reporting its first problem.
    def validate(fields, body, allow: nil, require_required: false)
      allow ||= {}
      by_name = fields.to_h { |f| [f["name"], f] }
      writable = fields.reject { |f| f["readOnly"] }.map { |f| f["name"] }
      out = []
      body.each do |key, value|
        next if allow[key]
        f = by_name[key]
        if f.nil?
          # "one of: " with nothing after it reads as a truncated message.
          accepted = writable.empty? ? "nothing — no writable fields are declared" : "one of: " + writable.join(", ")
          out << violation(ERROR_CODES["UNKNOWN_FIELD"], key, accepted, value)
          next
        end
        if f["readOnly"]
          out << violation(ERROR_CODES["READ_ONLY_FIELD"], key, "not writable (server-managed)", value)
          next
        end
        # Blank clears a field, which is legitimate only on one that is not
        # required.
        if blank_value?(value)
          out << violation(ERROR_CODES["MISSING_REQUIRED"], key, "a non-blank value (required field)", value) if f["required"]
          next
        end
        problem = field_problem(f, value)
        out << violation(problem[0], key, problem[1], value) if problem
      end
      # Create only: a required field left out entirely. One provided blank is
      # already reported above.
      if require_required
        fields.each do |f|
          next if !f["required"] || f["readOnly"] || body.key?(f["name"])
          out << violation(ERROR_CODES["MISSING_REQUIRED"], f["name"], "a non-blank value (required field)", nil)
        end
      end
      out
    end

    # [code, expected] for a non-blank value its field does not accept, or nil.
    def field_problem(f, value)
      type = f["type"]
      values = f["values"].is_a?(Array) && !f["values"].empty? ? f["values"] : nil
      if type == "datetime" && !looks_like_date(value)
        [ERROR_CODES["INVALID_DATE"], "an ISO 8601 date"]
      elsif f["dayKey"] && !day_key_value?(value)
        [ERROR_CODES["INVALID_DAYKEY"], 'a day key "YYYY-MM-DD"']
      elsif type == "string" && !value.is_a?(String)
        [ERROR_CODES["INVALID_STRING"], "text"]
      elsif type == "string" && f["max"].is_a?(Numeric) && Js.length(value) > f["max"]
        # `max` is published in describe, so a client plans against it.
        [ERROR_CODES["INVALID_STRING"], "text of at most #{Js.number_to_s(f["max"])} characters"]
      elsif type == "number" && !number_like?(value)
        [ERROR_CODES["INVALID_NUMBER"], "a number"]
      elsif type == "boolean" && value != true && value != false && value != "true" && value != "false"
        [ERROR_CODES["INVALID_BOOLEAN"], "true or false"]
      elsif type == "enum" && values && !enum_member?(values, value)
        [ERROR_CODES["INVALID_ENUM"], "one of: " + Js.join(values, " | ")]
      elsif type == "list<enum>" && values && !value.is_a?(Array)
        # The wire form of a list is an array; wrapping a scalar would hide a
        # client bug.
        [ERROR_CODES["INVALID_ENUM"], "an array of: " + Js.join(values, " | ")]
      elsif type == "list<enum>" && values && value.any? { |item| !enum_member?(values, item) }
        [ERROR_CODES["INVALID_ENUM"], "each of: " + Js.join(values, " | ")]
      end
    end

    # Read-back backstop: which non-blank requested values failed to land? A
    # write-only field is never read back, so it is never one of them.
    def divergences(fields, body, read)
      by_name = fields.to_h { |f| [f["name"], f] }
      out = []
      body.each do |key, requested|
        f = by_name[key]
        next if f.nil? || f["readOnly"] || f["writeOnly"]
        next if blank_value?(requested)
        stored = begin
          read.call(key)
        rescue StandardError
          nil
        end
        out << { "field" => key, "type" => f["type"], "stored" => Js.string(stored) } if blank_value?(stored)
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
      parts << "max=#{Js.number_to_s(f["max"])}" if f["max"].is_a?(Numeric)
      parts << "entity=#{f["entity"]}" if f["entity"]
      # Sorted as JavaScript sorts them: as strings, whatever their type.
      if f["values"].is_a?(Array) && !f["values"].empty?
        parts << "values=" + f["values"].map { |v| v.nil? ? "" : Js.string(v) }.sort_by { |v| Js.utf16(v) }.join("|")
      end
      parts.join(":")
    end

    # JSON with keys sorted at every depth, so declaration order cannot move a
    # hash. Parity: `stableJson` in @a2app/rules.
    def stable_json(value)
      case value
      when Hash
        "{" + value.keys.map(&:to_s).sort_by { |k| Js.utf16(k) }.map { |k| Js.dump(k) + ":" + stable_json(value[k]) }.join(",") + "}"
      when Array
        "[" + value.map { |v| stable_json(v) }.join(",") + "]"
      else
        Js.dump(value)
      end
    end

    def operation_print(o)
      flags = [["d", "destructive"], ["r", "readOnly"], ["i", "idempotent"]]
        .select { |_c, k| o[k] }.map { |c, _k| c }.join
      parts = [flags.empty? ? o["name"] : "#{o["name"]}:#{flags}"]
      parts << "mod=#{o["module"]}"
      parts << "on=#{o["entity"]}" if o["entity"]
      parts << "params=" + stable_json(o["params"]) if o["params"].is_a?(Hash) && !o["params"].empty?
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
        attrs = ["#{name}(#{value["fields"].map { |f| field_print(f) }.sort_by { |p| Js.utf16(p) }.join(",")})"]
        attrs << "auth" if value["auth"]
        attrs << "mod=#{value["module"]}"
        attrs.join(":")
      end
      parts = parts.sort_by { |p| Js.utf16(p) }
      ops = (operations || []).map { |o| operation_print(o) }.sort_by { |p| Js.utf16(p) }
      joined = parts.join(";") + "|" + ops.join(",")
      h = 5381
      # Over UTF-16 code units, as charCodeAt walks the string.
      Js.utf16(joined).unpack("n*").each { |unit| h = ((h * 33) ^ unit) & 0xFFFFFFFF }
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
        return true if value == "true"
        return false if value == "false"
        return value
      end
      if declared_type == "number" && value.is_a?(String)
        n = Js.number(value)
        return n.finite? ? n : value
      end
      value
    end

    # Equal after declared-type reading; a list or an object compares by its
    # JSON, so `list<ref>` membership is well defined.
    def same_value(a, b)
      return true if strictly_equal?(a, b)
      return false if a.nil? || b.nil?
      return Js.dump(a) == Js.dump(b) if a.is_a?(Array) || a.is_a?(Hash) || b.is_a?(Array) || b.is_a?(Hash)
      false
    end

    # JavaScript's ===, for the values JSON carries.
    def strictly_equal?(a, b)
      return a == b if a.is_a?(Numeric) && b.is_a?(Numeric)
      return a == b if a.is_a?(String) && b.is_a?(String)
      [true, false, nil].include?(a) && a.equal?(b)
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
      return Js.dump(v) if v.is_a?(Array) || v.is_a?(Hash)
      Js.string(v)
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
        subject = %w[all any not].any? { |k| inner.key?(k) } ? "the record" : inner["field"]
        return "the condition on #{subject} is not met"
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
            v["expected"] + "; got " + Js.dump(v["got"])
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

    # A stored value as a filter or a sort sees it: blank is "", anything else
    # String().
    def filter_str(value)
      value.nil? ? "" : Js.string(value)
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

    # The sort order of two stored values: blanks first, then as strings.
    def sort_compare(a, b)
      return 0 if a.nil? && b.nil?
      return -1 if a.nil?
      return 1 if b.nil?
      Js.utf16(Js.string(a)) <=> Js.utf16(Js.string(b))
    end

    def now_iso
      Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
    end

    # Milliseconds since the epoch: the unit every expiry below is kept in,
    # as adapter-core keeps it.
    def now_ms
      Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond)
    end

    # `ms` as the ISO 8601 string JavaScript's toISOString writes.
    def iso_at(ms)
      Time.at(ms / 1000, ms % 1000, :millisecond).utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
    end

    # An ISO 8601 timestamp as milliseconds since the epoch.
    def ms_of(iso)
      (Time.iso8601(iso).to_r * 1000).to_i
    end

    # A validated raw value in its stored form: a number string is the number
    # Number() reads ("1e3" is 1000, "0x1A" 26), a boolean string the boolean.
    def coerce(field, value)
      return value if value.nil? || value == ""
      return Js.number_value(Js.number(value)) if field["type"] == "number" && value.is_a?(String)
      return value == "true" if field["type"] == "boolean" && value.is_a?(String)
      value
    end

    # The content-addressed approval key for one exact operation call: the
    # hex SHA-256 of the RFC 8785 serialization of {operation, args}. The same
    # call gets the same key on every stack; no argument variant shares it.
    # Parity oracle: `approvalKey` in adapters/adapter-core/src/canon.ts.
    def approval_key(name, args)
      Digest::SHA256.hexdigest(Js.canonicalize({ "operation" => name, "args" => args.nil? ? {} : args }))
    end

    # A request body as adapter-core reads it through Object.keys: an object
    # is itself, an array or a string is its indexes, anything else is empty.
    # Index-like keys come first, in numeric order, as JavaScript orders them.
    def object_view(body)
      entries =
        case body
        when Hash then body.map { |k, v| [k.to_s, v] }
        when Array then body.each_with_index.map { |v, i| [i.to_s, v] }
        when String then body.each_char.with_index.map { |c, i| [i.to_s, c] }
        else []
        end
      indexes, names = entries.partition { |k, _v| k.match?(/\A(?:0|[1-9]\d*)\z/) && k.to_i < 4_294_967_295 }
      (indexes.sort_by { |k, _v| k.to_i } + names).to_h
    end
  end

  # ----------------------------------------------------------- rate limiter
  # A fixed window per (caller, route class). Parity oracle:
  # adapters/adapter-core/src/rate.ts.
  class RateLimiter
    WINDOW_MS = 60_000

    def initialize(limits, now_ms)
      @limits = limits
      @now_ms = now_ms
      @windows = {}
      @lock = Mutex.new
    end

    def check(caller_id, cls)
      limit = @limits[cls] || 0
      return { "allowed" => true, "limit" => limit, "retryAfterSeconds" => 0 } if limit <= 0
      @lock.synchronize do
        now = @now_ms.call
        key = "#{cls} #{caller_id}"
        window = @windows[key]
        window = @windows[key] = { "start" => now, "count" => 0 } if window.nil? || now - window["start"] >= WINDOW_MS
        window["count"] += 1
        if window["count"] > limit
          retry_ms = WINDOW_MS - (now - window["start"])
          next { "allowed" => false, "limit" => limit, "retryAfterSeconds" => [1, (retry_ms / 1000.0).ceil].max }
        end
        { "allowed" => true, "limit" => limit, "retryAfterSeconds" => 0 }
      end
    end
  end

  # ------------------------------------------------------------------ store

  # Records plus adapter-owned state: credentials and the auth tables,
  # idempotency keys, approvals, the event log, the task queue and the audit
  # log. Parity oracle: adapters/adapter-core/src/store.ts. This base class
  # keeps everything in memory — the disposable variant for tests and tooling;
  # the blueprint's live store is SqliteStore below, with the same interface,
  # where all of it is durable.
  #
  # A record, task or event read out is a COPY: change it and put it back, or
  # the change never happened.
  class Store
    include Rules

    # The keyed tables the auth layer owns (spec/v0_2/auth.md): accounts,
    # sessions, invites and device codes. Rows are keyed by id or by the hash
    # of the secret that finds them; no secret is ever a key or a value.
    AUTH_TABLES = %w[users sessions invites devices].freeze
    # A retried write arrives within a day; an approval is for a decision made
    # now.
    IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
    APPROVAL_TTL_MS = 10 * 60 * 1000
    # The event log and the audit log are rings: the oldest entries fall off
    # the back, and `seq` keeps counting across the prune, so a saved event
    # cursor stays good.
    EVENT_RETENTION = 5000
    AUDIT_RETENTION = 5000
    # A task that has not reached a terminal state: the one a repeated request
    # joins.
    OPEN_TASK = %w[submitted working input-required].freeze

    attr_reader :seed
    attr_accessor :wants_seed
    # Set by the Adapter from the app's declarations: the event types it may
    # emit (empty means none were declared), and the app id every event and
    # task names.
    attr_accessor :event_types, :app_id

    # `clock` is milliseconds since the epoch (the real clock by default).
    def initialize(seed = nil, clock: nil, event_retention: EVENT_RETENTION, audit_retention: AUDIT_RETENTION)
      @seed = seed || {}
      # A fresh in-memory store is always empty, so it always takes the seed.
      # SqliteStore sets this false when the database file already existed:
      # re-seeding an existing database on every boot would resurrect a seed
      # record the user deleted.
      @wants_seed = true
      @clock = clock || -> { now_ms }
      @event_retention = event_retention
      @audit_retention = audit_retention
      @event_types = []
      @app_id = nil
      # Puma serves requests on a thread pool. Reentrant, so a step made of
      # several statements holds it throughout.
      @lock = Monitor.new
      @rows = {}
      # credentialId -> grant, and tokenHash -> credentialId
      @grants = {}
      @grant_tokens = {}
      @tables = AUTH_TABLES.to_h { |t| [t, {}] }
      @idem = {}
      @approvals = {}
      @events = []
      @event_seq = 0
      @tasks = {}
      # occurrence key -> task id, so one occurrence makes one task
      @dedup = {}
      @audit = []
    end

    # The store's clock, in milliseconds since the epoch.
    def time_ms
      @clock.call
    end

    def copy(value)
      value.nil? ? nil : JSON.parse(Js.dump(value))
    end

    # records ---------------------------------------------------------------

    # Every record of one entity — the single hook a durable subclass
    # overrides for reads; list_records keeps the shared filter/sort/page.
    def all_records(entity)
      @lock.synchronize { (@rows[entity] || {}).values.map { |r| copy(r) } }
    end

    # `query` is what the adapter passes: "where" (field => value: a member
    # sees only the records it owns, applied before anything else), "filter"
    # and "sort" as given, and "perPage"/"page" as the numbers Number() makes
    # of them. Paging is JavaScript's slice, so `?page=0` or `?perPage=abc`
    # select what they select on adapter-core. Parity oracle: the react-node
    # starter's listRecords.
    def list_records(entity, query)
      items = all_records(entity)
      (query["where"] || {}).each { |field, value| items = items.select { |r| r[field] == value } }
      flt = query["filter"]
      items = items.select(&match_filter(flt)) if flt.is_a?(String) && !flt.empty?
      sort = query["sort"]
      if sort.is_a?(String) && !sort.empty?
        desc = sort.start_with?("-")
        key = desc ? sort[1..] : sort
        # Stable, as JavaScript's sort is: equal values keep their order.
        items = items.each_with_index.sort do |(a, i), (b, j)|
          order = sort_compare(a[key], b[key])
          (desc ? -order : order).nonzero? || i <=> j
        end.map(&:first)
      end
      total = items.length
      per_page = query["perPage"].nil? ? total : query["perPage"]
      page = query["page"].nil? ? 1 : query["page"]
      start = (page - 1) * per_page
      {
        "items" => Js.slice(items, start, start + per_page),
        "page" => page, "perPage" => per_page, "totalItems" => total,
      }
    end

    def get_record(entity, rec_id)
      @lock.synchronize { copy((@rows[entity] || {})[rec_id]) }
    end

    # Store a record; returns it as stored, which is what the read-back checks.
    def put_record(entity, rec)
      stored = copy(rec)
      @lock.synchronize { (@rows[entity] ||= {})[stored["id"]] = stored }
      copy(stored)
    end

    def delete_record(entity, rec_id)
      @lock.synchronize { !(@rows[entity] || {}).delete(rec_id).nil? }
    end

    # grants ----------------------------------------------------------------
    # A credential (spec/v0_2/auth.md §2.1): held only as the SHA-256 of its
    # token, found by that hash. A grant read out is a value: change it with
    # merge, then put_grant it back.
    def grant_by_token_hash(token_hash)
      @lock.synchronize do
        id = @grant_tokens[token_hash]
        id.nil? ? nil : @grants[id]
      end
    end

    def grant_by_id(credential_id)
      @lock.synchronize { @grants[credential_id] }
    end

    def put_grant(grant)
      @lock.synchronize do
        previous = @grants[grant["credentialId"]]
        @grant_tokens.delete(previous["tokenHash"]) if previous && previous["tokenHash"] != grant["tokenHash"]
        @grants[grant["credentialId"]] = grant
        @grant_tokens[grant["tokenHash"]] = grant["credentialId"]
      end
    end

    def delete_grant(credential_id)
      @lock.synchronize do
        g = @grants.delete(credential_id)
        @grant_tokens.delete(g["tokenHash"]) if g
      end
    end

    def list_grants
      @lock.synchronize { @grants.values }
    end

    # auth rows -------------------------------------------------------------
    def row(table, key)
      @lock.synchronize { @tables.fetch(table)[key] }
    end

    def put_row(table, key, row)
      @lock.synchronize { @tables.fetch(table)[key] = row }
    end

    def delete_row(table, key)
      @lock.synchronize { @tables.fetch(table).delete(key) }
    end

    # Every row of one table, as [key, row] pairs.
    def rows_of(table)
      @lock.synchronize { @tables.fetch(table).to_a }
    end

    # idempotency / approvals ----------------------------------------------

    # What an idempotency key already produced in `scope` (an entity for a
    # create, `entity#id` for an update, `op:<name>` for an operation), or
    # nil. A key is kept 24 hours.
    def idem_get(scope, key)
      @lock.synchronize do
        found = @idem[[scope, key]]
        next nil if found.nil?
        if time_ms - found["at"] > IDEMPOTENCY_TTL_MS
          @idem.delete([scope, key])
          next nil
        end
        found["recordId"]
      end
    end

    def idem_put(scope, key, record_id)
      @lock.synchronize { @idem[[scope, key]] = { "recordId" => record_id, "at" => time_ms } }
    end

    # An approval key lives 10 minutes.
    def approval_issue(key)
      @lock.synchronize { @approvals[key] = time_ms + APPROVAL_TTL_MS }
    end

    # True once for a key that was issued and has not expired; never again.
    def approval_consume(key)
      @lock.synchronize do
        expires = @approvals.delete(key)
        !expires.nil? && expires >= time_ms
      end
    end

    # events ----------------------------------------------------------------
    def new_event(etype, payload)
      { "id" => Auth.new_id("evt"), "app" => @app_id, "type" => etype, "payload" => payload,
        "createdAt" => iso_at(time_ms) }
    end

    def append_event(etype, payload)
      @lock.synchronize do
        @event_seq += 1
        ev = copy(new_event(etype, payload)).merge("seq" => @event_seq)
        @events << ev
        @events.shift(@events.length - @event_retention) if @events.length > @event_retention
        copy(ev)
      end
    end

    # The events after `cursor` (where a previous read ended), and the cursor
    # to read from next.
    def events_since(cursor)
      from = event_cursor(cursor)
      fresh = @lock.synchronize { @events.select { |e| e["seq"] > from }.map { |e| copy(e) } }
      { "events" => fresh, "nextCursor" => fresh.empty? ? Js.number_to_s(from) : fresh[-1]["seq"].to_s }
    end

    # A cursor as adapter-core reads one: a number, where anything else
    # (absent, "abc") reads from the beginning.
    def event_cursor(cursor)
      return 0 if cursor.nil? || cursor.empty?
      n = Js.number(cursor)
      n.nan? || n.zero? ? 0 : n
    end

    # tasks -----------------------------------------------------------------

    # `principal` is who queued it (spec/v0_2/auth.md §6.1); nil for work the
    # app queued on its own. Ids are random: a task id is what a task
    # credential is bound to, so one must never be handed out twice.
    def new_task(event_id, capability, payload, dedup_key, principal)
      at = iso_at(time_ms)
      {
        "id" => Auth.new_id("tsk"), "app" => @app_id, "event" => event_id, "status" => "submitted",
        "request" => { "capability" => capability, "payload" => payload, "principal" => principal },
        "claim" => nil, "progress" => { "step" => nil, "percent" => 0 }, "result" => nil, "reason" => nil,
        "ask" => nil, "createdAt" => at, "updatedAt" => at, "dedupKey" => dedup_key, "deliveries" => 1,
      }
    end

    # Queue a task, or return the one this occurrence (`dedup_key`) already
    # queued while that task is open (spec/v0_2/auth.md §6.1). Once it is
    # completed, failed or canceled, asking again is a new request: returning
    # the finished task would leave the person no way to ask again.
    def enqueue_task(event_id, capability, payload, dedup_key = nil, principal: nil)
      @lock.synchronize do
        existing = dedup_key && @tasks[@dedup[dedup_key]]
        next copy(existing) if existing && OPEN_TASK.include?(existing["status"])
        task = copy(new_task(event_id, capability, payload, dedup_key, principal))
        @tasks[task["id"]] = task
        @dedup[dedup_key] = task["id"] if dedup_key
        copy(task)
      end
    end

    def get_task(task_id)
      @lock.synchronize { copy(@tasks[task_id]) }
    end

    def list_tasks(status)
      @lock.synchronize do
        @tasks.values.select { |t| status.nil? || status.empty? || t["status"] == status }.map { |t| copy(t) }
      end
    end

    def save_task(task)
      task["updatedAt"] = iso_at(time_ms)
      @lock.synchronize { @tasks[task["id"]] = copy(task) }
    end

    def sweep(timeout_ms, max_deliveries)
      @lock.synchronize { @tasks.each_value { |task| reclaim(task, timeout_ms, max_deliveries) } }
    end

    # Return an abandoned claim to the queue: a "working" task with no update
    # for `timeout_ms` goes back to "submitted" so another agent can take it,
    # and fails with "redelivery_exhausted" once it has been handed out
    # `max_deliveries` times. Never a silent drop. True when it changed.
    def reclaim(task, timeout_ms, max_deliveries)
      now = time_ms
      return false unless task["status"] == "working" && now - ms_of(task["updatedAt"]) >= timeout_ms
      if task["deliveries"] >= max_deliveries
        task["status"] = "failed"
        task["reason"] = "redelivery_exhausted"
      else
        task["status"] = "submitted"
        task["claim"] = nil
        task["deliveries"] += 1
      end
      task["updatedAt"] = iso_at(now)
      true
    end

    # Emit a declared event and, when `capability` is given, queue a task for
    # an agent. This is the app->agent seam an operation runner reaches through
    # the `store` it is handed. Returns {"eventId", "taskId"}; "taskId" is nil
    # when no capability was named, because an event alone asks no agent for
    # work. An undeclared event type raises, and nothing is emitted.
    #
    # `principal` is who asked for the work: the caller of the operation that
    # fires this. The agent that takes the task acts as them (spec/v0_2/auth.md
    # §6). A runner never passes it — the store it is handed does (see
    # CallerStore); work the app queues on its own has none and runs as owner.
    def trigger(etype, payload, capability = nil, principal: nil, dedup_key: nil)
      if !@event_types.empty? && !@event_types.include?(etype)
        raise ArgumentError, "event type \"#{etype}\" is not declared"
      end

      ev = append_event(etype, payload)
      task_id = nil
      if capability && capability != ""
        # Dedup is keyed on the OCCURRENCE, not on the event record: the same
        # trigger firing twice while its task is open must make one task
        # (enqueue_task says what "open" is). The event id is fresh per
        # emit, so keying on it would deduplicate nothing. The occurrence is
        # what the app asked for (type, capability, payload), canonicalized
        # (RFC 8785) so key order cannot tell two identical triggers apart.
        # Who asked is part of it: the same request from two people is two
        # tasks, each run as the person who asked.
        occurrence = { "type" => etype, "capability" => capability, "payload" => payload }
        occurrence["principal"] = principal if principal && principal != ""
        key = dedup_key || "sha256:" + Digest::SHA256.hexdigest(Js.canonicalize(occurrence))
        task_id = enqueue_task(ev["id"], capability, payload, key, principal: principal)["id"]
      end
      { "eventId" => ev["id"], "taskId" => task_id }
    end

    # audit -----------------------------------------------------------------
    def append_audit(entry)
      @lock.synchronize do
        @audit << copy(entry)
        @audit.shift(@audit.length - @audit_retention) if @audit.length > @audit_retention
      end
    end

    # The last `n` audit entries, oldest first.
    def audit_tail(n)
      @lock.synchronize { @audit.last(n).map { |e| copy(e) } }
    end
  end

  # The blueprint's live store: records and every table of adapter state in
  # SQLite (the `sqlite3` gem — the store, NOT ActiveRecord; this stack never
  # loads AR).
  #
  # Records are JSON rows in one table keyed (entity, id): the schema stays
  # declarative and additive (a new field simply appears in the JSON) while
  # the DATABASE is a real on-disk file inside the toolkit's declared
  # lifecycle dataDir — which is what backup/restore/promote protect. WAL
  # keeps a reader and a writer from blocking each other.
  #
  # The adapter's state lives here too, in tables of its own, never among the
  # records, because a restart is exactly when it is needed: a retried POST
  # arrives (idempotency keys), an agent resumes reading events from its
  # cursor, a person approves the destructive call they were asked about, a
  # bridge finishes a task with that task's credential. Nobody is signed out
  # and no credential is forgotten.
  #
  # No token is ever written: a credential is stored as the hash of its token
  # (and before 0.2 this stack kept credentials in memory only, so no older
  # database holds a plaintext one).
  #
  # Writes are durable when the call returns — there is no separate persist()
  # step. A hash read from this store is a COPY: mutate it, then put_record()
  # it back, or the change never happened.
  class SqliteStore < Store
    TABLES = [
      "CREATE TABLE IF NOT EXISTS records (entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, " \
      "PRIMARY KEY (entity, id))",
      # `entity` is the key's scope: an entity, `entity#id` or `op:<name>`.
      "CREATE TABLE IF NOT EXISTS idem (entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, " \
      "at INTEGER NOT NULL, PRIMARY KEY (entity, key))",
      "CREATE TABLE IF NOT EXISTS grants (credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, " \
      "data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS auth_rows (tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, " \
      "PRIMARY KEY (tbl, key))",
      "CREATE TABLE IF NOT EXISTS approvals (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
      # AUTOINCREMENT: a seq is never reused, even after the ring dropped it.
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS dedup (key TEXT PRIMARY KEY, task_id TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)",
    ].freeze

    def initialize(path, seed = nil, **options)
      super(seed, **options)
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
      # One connection, guarded by the store's lock: correct under Puma's
      # threads without a pool.
      @db = SQLite3::Database.new(full)
      @lock.synchronize do
        @db.execute("PRAGMA journal_mode=WAL")
        TABLES.each { |ddl| @db.execute(ddl) }
        # An idempotency table from before keys expired: their 24 hours start
        # now.
        unless @db.execute("PRAGMA table_info(idem)").any? { |column| column[1] == "at" }
          @db.execute("ALTER TABLE idem ADD COLUMN at INTEGER NOT NULL DEFAULT 0")
          @db.execute("UPDATE idem SET at = ?", [time_ms])
        end
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
      rows = @lock.synchronize { @db.execute("SELECT data FROM records WHERE entity = ?", [entity]) }
      rows.map { |row| JSON.parse(row[0]) }
    end

    def get_record(entity, rec_id)
      row = @lock.synchronize do
        @db.get_first_row("SELECT data FROM records WHERE entity = ? AND id = ?", [entity, rec_id])
      end
      row.nil? ? nil : JSON.parse(row[0])
    end

    # Returns the record as stored: a value JSON cannot hold (a non-finite
    # number) comes back blank, and the read-back reports it.
    def put_record(entity, rec)
      data = Js.dump(rec)
      @lock.synchronize do
        @db.execute(
          "INSERT INTO records (entity, id, data) VALUES (?, ?, ?) " \
          "ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
          [entity, rec["id"], data]
        )
      end
      JSON.parse(data)
    end

    def delete_record(entity, rec_id)
      @lock.synchronize do
        @db.execute("DELETE FROM records WHERE entity = ? AND id = ?", [entity, rec_id])
        @db.changes > 0
      end
    end

    # grants ----------------------------------------------------------------
    def grant_by_token_hash(token_hash)
      row = @lock.synchronize { @db.get_first_row("SELECT data FROM grants WHERE token_hash = ?", [token_hash]) }
      row.nil? ? nil : JSON.parse(row[0])
    end

    def grant_by_id(credential_id)
      row = @lock.synchronize { @db.get_first_row("SELECT data FROM grants WHERE credential_id = ?", [credential_id]) }
      row.nil? ? nil : JSON.parse(row[0])
    end

    def put_grant(grant)
      @lock.synchronize do
        @db.execute(
          "INSERT INTO grants (credential_id, token_hash, data) VALUES (?, ?, ?) " \
          "ON CONFLICT (credential_id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data",
          [grant["credentialId"], grant["tokenHash"], Js.dump(grant)]
        )
      end
    end

    def delete_grant(credential_id)
      @lock.synchronize { @db.execute("DELETE FROM grants WHERE credential_id = ?", [credential_id]) }
    end

    def list_grants
      @lock.synchronize { @db.execute("SELECT data FROM grants") }.map { |r| JSON.parse(r[0]) }
    end

    # auth rows -------------------------------------------------------------
    def row(table, key)
      found = @lock.synchronize do
        @db.get_first_row("SELECT data FROM auth_rows WHERE tbl = ? AND key = ?", [table, key])
      end
      found.nil? ? nil : JSON.parse(found[0])
    end

    def put_row(table, key, row)
      @lock.synchronize do
        @db.execute(
          "INSERT INTO auth_rows (tbl, key, data) VALUES (?, ?, ?) " \
          "ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
          [table, key, Js.dump(row)]
        )
      end
    end

    def delete_row(table, key)
      @lock.synchronize { @db.execute("DELETE FROM auth_rows WHERE tbl = ? AND key = ?", [table, key]) }
    end

    def rows_of(table)
      found = @lock.synchronize { @db.execute("SELECT key, data FROM auth_rows WHERE tbl = ?", [table]) }
      found.map { |key, data| [key, JSON.parse(data)] }
    end

    # idempotency / approvals ----------------------------------------------
    def idem_get(scope, key)
      @lock.synchronize do
        found = @db.get_first_row("SELECT rec_id, at FROM idem WHERE entity = ? AND key = ?", [scope, key])
        next nil if found.nil?
        if time_ms - found[1] > IDEMPOTENCY_TTL_MS
          @db.execute("DELETE FROM idem WHERE entity = ? AND key = ?", [scope, key])
          next nil
        end
        found[0]
      end
    end

    def idem_put(scope, key, record_id)
      @lock.synchronize do
        @db.execute(
          "INSERT INTO idem (entity, key, rec_id, at) VALUES (?, ?, ?, ?) " \
          "ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id, at = excluded.at",
          [scope, key, record_id, time_ms]
        )
      end
    end

    def approval_issue(key)
      now = time_ms
      @lock.synchronize do
        # An expired key can never be consumed: drop those as new ones come.
        @db.execute("DELETE FROM approvals WHERE expires_at < ?", [now])
        @db.execute(
          "INSERT INTO approvals (key, expires_at) VALUES (?, ?) " \
          "ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at",
          [key, now + APPROVAL_TTL_MS]
        )
      end
    end

    def approval_consume(key)
      @lock.synchronize do
        found = @db.get_first_row("SELECT expires_at FROM approvals WHERE key = ?", [key])
        next false if found.nil?
        @db.execute("DELETE FROM approvals WHERE key = ?", [key])
        found[0] >= time_ms
      end
    end

    # events ----------------------------------------------------------------
    def append_event(etype, payload)
      ev = copy(new_event(etype, payload))
      @lock.synchronize do
        @db.transaction do
          @db.execute("INSERT INTO events (data) VALUES (?)", [Js.dump(ev)])
          ev["seq"] = @db.last_insert_row_id
          @db.execute("DELETE FROM events WHERE seq <= ?", [ev["seq"] - @event_retention])
        end
      end
      ev
    end

    def events_since(cursor)
      from = event_cursor(cursor)
      rows = @lock.synchronize { @db.execute("SELECT seq, data FROM events WHERE seq > ? ORDER BY seq", [from]) }
      fresh = rows.map { |seq, data| JSON.parse(data).merge("seq" => seq) }
      { "events" => fresh, "nextCursor" => fresh.empty? ? Js.number_to_s(from) : fresh[-1]["seq"].to_s }
    end

    # tasks -----------------------------------------------------------------
    def enqueue_task(event_id, capability, payload, dedup_key = nil, principal: nil)
      @lock.synchronize do
        row = dedup_key && @db.get_first_row(
          "SELECT tasks.data FROM dedup JOIN tasks ON tasks.id = dedup.task_id WHERE dedup.key = ?", [dedup_key]
        )
        existing = row && JSON.parse(row[0])
        # Joins the earlier task only while it is open; a finished one is
        # asked again as a new task, and the occurrence now names that one.
        next existing if existing && OPEN_TASK.include?(existing["status"])
        task = copy(new_task(event_id, capability, payload, dedup_key, principal))
        @db.transaction do
          @db.execute("INSERT INTO tasks (id, data) VALUES (?, ?)", [task["id"], Js.dump(task)])
          if dedup_key
            @db.execute(
              "INSERT INTO dedup (key, task_id) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET task_id = excluded.task_id",
              [dedup_key, task["id"]]
            )
          end
        end
        task
      end
    end

    def get_task(task_id)
      row = @lock.synchronize { @db.get_first_row("SELECT data FROM tasks WHERE id = ?", [task_id]) }
      row.nil? ? nil : JSON.parse(row[0])
    end

    # In the order they were queued.
    def list_tasks(status)
      rows = @lock.synchronize do
        if status.nil? || status.empty?
          @db.execute("SELECT data FROM tasks ORDER BY rowid")
        else
          @db.execute("SELECT data FROM tasks WHERE json_extract(data, '$.status') = ? ORDER BY rowid", [status])
        end
      end
      rows.map { |row| JSON.parse(row[0]) }
    end

    def save_task(task)
      task["updatedAt"] = iso_at(time_ms)
      @lock.synchronize do
        @db.execute(
          "INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
          [task["id"], Js.dump(task)]
        )
      end
    end

    def sweep(timeout_ms, max_deliveries)
      @lock.synchronize do
        @db.execute("SELECT data FROM tasks WHERE json_extract(data, '$.status') = 'working'").each do |(data)|
          task = JSON.parse(data)
          next unless reclaim(task, timeout_ms, max_deliveries)
          @db.execute("UPDATE tasks SET data = ? WHERE id = ?", [Js.dump(task), task["id"]])
        end
      end
    end

    # audit -----------------------------------------------------------------
    def append_audit(entry)
      @lock.synchronize do
        @db.transaction do
          @db.execute("INSERT INTO audit (data) VALUES (?)", [Js.dump(entry)])
          @db.execute("DELETE FROM audit WHERE id <= ?", [@db.last_insert_row_id - @audit_retention])
        end
      end
    end

    def audit_tail(n)
      rows = @lock.synchronize { @db.execute("SELECT data FROM audit ORDER BY id DESC LIMIT ?", [n]) }
      rows.reverse.map { |row| JSON.parse(row[0]) }
    end
  end

  # The store as an operation runner is handed it: the live store, except that
  # a task it queues records who asked — the runner's caller — so the agent
  # that takes it acts as them (spec/v0_2/auth.md §6). The adapter supplies
  # the caller, so no runner can forget to, or name someone else.
  class CallerStore < SimpleDelegator
    def initialize(store, principal)
      super(store)
      @principal = principal
    end

    def trigger(etype, payload, capability = nil, dedup_key: nil)
      __getobj__.trigger(etype, payload, capability, principal: @principal, dedup_key: dedup_key)
    end
  end

  # Raised by an operation runner to refuse with a machine code of its own:
  # the caller is answered `http_status` (400 by default) with `code`,
  # `message` and any `extra` fields, where any other exception is a 500
  # `operation_failed`. Parity oracle: OperationError in
  # adapters/adapter-core/src/types.ts.
  #
  #     raise A2appAdapter::OperationError.new("task_done", "That task is already done.", 409)
  class OperationError < StandardError
    attr_reader :code, :http_status, :extra

    def initialize(code, message, http_status = 400, extra = nil)
      super(message)
      @code = code
      @http_status = http_status
      @extra = extra
    end
  end

  # Serving the built View, and the version marker for what it serves — the
  # framework's answer to the stale tab. Parity oracle:
  # adapters/adapter-core/src/static.ts.
  #
  # Every file is answered with ETag, Last-Modified and Cache-Control:
  # no-cache, and a conditional request with a 304, so a plain reload always
  # revalidates and an unchanged file costs no body. `version` fingerprints
  # the bytes served (plus `fingerprint_paths`), which is identity's
  # `appVersion`: the one marker that moves for a View-only change.
  class StaticView
    MIME = {
      ".html" => "text/html; charset=utf-8",
      ".js" => "text/javascript; charset=utf-8",
      ".mjs" => "text/javascript; charset=utf-8",
      ".css" => "text/css; charset=utf-8",
      ".json" => "application/json",
      ".map" => "application/json",
      ".svg" => "image/svg+xml",
      ".ico" => "image/x-icon",
      ".png" => "image/png",
      ".jpg" => "image/jpeg",
      ".jpeg" => "image/jpeg",
      ".gif" => "image/gif",
      ".webp" => "image/webp",
      ".avif" => "image/avif",
      ".woff" => "font/woff",
      ".woff2" => "font/woff2",
      ".txt" => "text/plain; charset=utf-8",
    }.freeze
    NOT_FOUND = { "a2app" => true, "ok" => false, "code" => "not_found", "message" => "No such route." }.freeze

    # `aliases` maps an exact URL path to a file outside `dir` (how the
    # system-owned helpers are served without living in the agent's View);
    # alias targets count towards `version`, as do `fingerprint_paths`.
    # `version_salt` (manifest.appVersion) lets an author move it by hand.
    def initialize(dir, aliases: {}, fingerprint_paths: [], version_salt: nil, cache_control: "no-cache",
                   index_file: "index.html", version_ttl_ms: 1000)
      @root = File.expand_path(dir)
      @aliases = aliases
      @versioned = [@root, *aliases.values, *fingerprint_paths]
      @version_salt = version_salt
      @cache_control = cache_control
      @index_file = index_file
      @version_ttl_ms = version_ttl_ms
      @version_lock = Mutex.new
      @version = nil
    end

    # `av_…` over the served bytes, re-hashed at most once per TTL: every open
    # tab polls identity, so hashing the tree per probe would make the
    # watcher the app's main workload.
    def version
      @version_lock.synchronize do
        now = Rules.now_ms
        if @version.nil? || now - @version[1] >= @version_ttl_ms
          salt = @version_salt.nil? ? "" : "#{@version_salt}\0"
          @version = ["av_" + Digest::SHA256.hexdigest(salt + self.class.fingerprint(@versioned))[0, 16], now]
        end
        @version[0]
      end
    end

    # A content fingerprint over files and directories: paths (relative to
    # each entry) and bytes, never mtimes — a re-stamped copy of the same
    # bytes is not a new version. Symlinks are not followed.
    def self.fingerprint(paths)
      digest = Digest::SHA256.new
      paths.each do |path|
        root = File.expand_path(path)
        files_under(root).each do |file|
          digest.update(file[root.length..])
          digest.update("\0")
          digest.update(File.binread(file))
          digest.update("\0")
        end
      end
      digest.hexdigest
    end

    def self.files_under(root)
      return [] if File.symlink?(root) || !File.exist?(root)
      return [root] unless File.directory?(root)
      Dir.children(root).flat_map { |name| files_under(File.join(root, name)) }.sort
    end

    # Answer one request for `raw_path` (as sent, still percent-encoded):
    # [status, headers, body or nil].
    def serve(method, raw_path, headers)
      file = resolve(raw_path)
      # Path before method: 405 is only for a file that exists.
      return [404, { "content-type" => "application/json" }, Js.dump(NOT_FOUND)] if file.nil?
      unless %w[GET HEAD].include?(method)
        return [405, { "content-type" => "application/json", "allow" => "GET, HEAD" },
                Js.dump({ "a2app" => true, "ok" => false, "code" => "method_not_allowed",
                          "message" => "Static assets are GET-only." })]
      end
      body = File.binread(file)
      modified = File.mtime(file)
      out = {
        "content-type" => MIME[File.extname(file).downcase] || "application/octet-stream",
        "cache-control" => @cache_control,
        "etag" => %("#{Digest::SHA256.hexdigest(body)[0, 32]}"),
        "last-modified" => modified.httpdate,
      }
      # ETag wins where both validators are present: it compares content,
      # while If-Modified-Since compares whole seconds.
      none_match = headers["if-none-match"]
      fresh = etag_matches?(none_match, out["etag"])
      if !fresh && none_match.nil?
        since = begin
          Time.httpdate(headers["if-modified-since"].to_s)
        rescue ArgumentError
          nil
        end
        fresh = !since.nil? && modified.to_i <= since.to_i
      end
      return [304, out, nil] if fresh
      [200, out.merge("content-length" => body.bytesize.to_s), method == "HEAD" ? nil : body]
    end

    # The file a request names, or nil for every shape that is not one to
    # serve (traversal, a bad escape, a directory): one honest 404.
    def resolve(raw_path)
      target = @aliases[raw_path]
      return File.file?(target) ? target : nil unless target.nil?
      rel = Js.decode_uri_component(raw_path)
      return nil if rel.nil? || rel.include?("\0")
      rel = "/#{@index_file}" if rel == "/" || rel.empty?
      file = File.expand_path(File.join(@root, rel))
      # The separator is part of the containment test, so a sibling whose name
      # merely begins with the root's is not inside it.
      return nil unless file == @root || file.start_with?(@root + File::SEPARATOR)
      File.file?(file) ? file : nil
    end

    # If-None-Match, compared weakly (RFC 9110 13.1.2); `*` matches anything.
    def etag_matches?(header, etag)
      return false if header.nil?
      strip = ->(s) { s.strip.delete_prefix("W/") }
      header.split(",").any? { |candidate| strip.call(candidate) == "*" || strip.call(candidate) == strip.call(etag) }
    end
  end

  # Rack middleware: the Host check, in front of everything the app serves —
  # the adapter's routes, the View, and anything the framework under it adds.
  # Binding loopback does not stop a page on evil.com whose DNS re-resolves
  # to 127.0.0.1 from reaching the app, but its Host header still says
  # evil.com. `adapter` is a callable returning the Adapter, which knows the
  # app's own hosts.
  class HostGuard
    def initialize(app, adapter)
      @app = app
      @adapter = adapter
    end

    def call(env)
      refused = @adapter.call.host_refusal("host" => env["HTTP_HOST"])
      return @app.call(env) if refused.nil?
      [refused[0], { "content-type" => "application/json" }, [Js.dump(refused[1])]]
    end
  end

  # ---------------------------------------------------------------- adapter
  class Adapter
    include Rules

    # The framework's account page (sign in, invites, people, the agents acting
    # for you), served by the wiring from a2app-account.html.
    ACCOUNT_URL = "/_a2app/account"
    SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
    INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
    SIGN_IN_FAILURES = 10
    SIGN_IN_WINDOW_MS = 15 * 60 * 1000
    LOGIN_MAX = 254
    NAME_MAX = 100
    # Credential lifetimes, in seconds (spec/v0_2/auth.md §2.1, §6.2). A task
    # credential's task ending kills it sooner.
    DEFAULT_EXPIRES_SECONDS = 30 * 24 * 60 * 60
    MIN_EXPIRES_SECONDS = 60
    MAX_EXPIRES_SECONDS = 365 * 24 * 60 * 60
    TASK_CREDENTIAL_SECONDS = 60 * 60
    # How long a revoked or expired credential is remembered (spec §2.1).
    GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
    # `lastUsedAt` is written at most this often, so use does not mean a disk
    # write per request.
    LAST_USED_RESOLUTION_MS = 60_000
    TERMINAL_TASK = %w[completed failed canceled].freeze
    # Device-code sign-in (spec §7): codes live 10 minutes; agents poll every
    # 5 s, and 5 s more each time they poll too soon.
    CODE_TTL_SECONDS = 600
    POLL_INTERVAL_SECONDS = 5
    SLOW_DOWN_STEP_SECONDS = 5
    # Wrong confirmation codes a device request survives before it is void,
    # and where an agent on the person's own computer waits for the code.
    CONFIRM_ATTEMPTS = 5
    LOOPBACK_CALLBACK = "/a2app/callback"
    LOOPBACK_PORTS = (1024..65_535).freeze
    # A tab's update watcher says it is still open on every identity poll;
    # one silent this long is gone. At most this many are remembered.
    VIEWER_TTL_MS = 60_000
    VIEWER_CAP = 1_000
    # Path prefixes that are the adapter's alone: a miss below one is the
    # adapter's 404, and anything else is the View's.
    ADAPTER_NAMESPACES = %w[/api/_a2app /api/ops /api/collections].freeze
    # A miss is usually a guessed route, so it names the routes that answer.
    UNKNOWN_ROUTE_MESSAGE = "No such route. Operations are invoked with POST /api/ops/<name>; "                             "GET /api/_a2app/describe lists them."
    # The app's administrator: the admin credential, and the only principal of
    # an `authMode: none` app.
    OWNER = { "id" => "owner", "name" => "Owner", "role" => "owner", "active" => true }.freeze
    # Said to an agent whose credential stopped working (revoked, expired, or
    # its person deactivated): a new one is the person's to give.
    RENEW_HINT = "Ask the person this agent acts for to approve it again (a2app <app> login), " \
                 "or the app's owner for a new credential."

    attr_reader :store

    # `token` is the app's own .agent-token: its admin credential (spec/v0_2/
    # auth.md §2.3). `permissions_of` is what a principal may do, as scopes
    # (§3; default `*` for every active principal); `capabilities` what each
    # capability's task credential holds (§6.2; default `*`). `audit`
    # replaces where audit entries go (the store's ring by default);
    # `rate_limits` overrides requests per minute per caller and class.
    def initialize(app_id:, app_name:, entities:, operations:, store:, token:,
                   modules: nil, allowed_origins: nil, public_url: nil, operation_runners: nil, events: nil,
                   auth_mode: "none", permissions_of: nil, capabilities: nil,
                   credential_hint: nil, env: nil, app_version: nil, audit: nil, rate_limits: nil)
      @app_id = app_id
      @app_name = app_name
      # {name => {"fields" => [...], "module" => str, "summary"?, "auth"?, "writeAllow"?, "ownedBy"?}}
      @entity_defs = entities
      @operations = operations
      @modules = modules || []
      @op_by_name = operations.to_h { |o| [o["name"], o] }
      @capabilities = capabilities || {}
      problems = model_problems
      declared = all_scopes
      @capabilities.each do |capability, decl|
        unknown = (decl["scopes"] || []).reject { |s| s == "*" || declared.include?(s) }
        unless unknown.empty?
          problems << "capability \"#{capability}\" needs scopes this app does not declare: #{unknown.join(", ")}"
        end
      end
      unless problems.empty?
        # Fail fast: a model whose entities or operations name a module that
        # was never declared cannot be walked, so serving it would answer 200
        # while omitting real capability.
        raise ArgumentError,
              "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - " +
              problems.join("\n  - ")
      end
      @store = store
      # The declared event types are what keep the app->agent queue from being
      # an open channel: `trigger` refuses a type that is not declared, so the
      # set of things this app can ever ask an agent to react to is fixed by its
      # author rather than by whatever a runner passes at the moment of firing.
      store.event_types = (events || []).map { |e| e["type"] }
      store.app_id = app_id
      @auth_mode = auth_mode
      @permissions_of = permissions_of
      # The public URL (A2APP_PUBLIC_URL, resolved by Network.policy) is one
      # more of the app's own origins, and the hosts this app answers to are
      # derived from those origins: reached at its public URL, it answers
      # there and nowhere new.
      own_origins = (allowed_origins || []) + [public_url].compact
      @own_origins = own_origins
      @public_url = public_url
      @allowed_origins = own_origins.to_h { |o| [o, true] }
      @allowed_hosts = {}
      own_origins.each do |origin|
        uri = URI.parse(origin)
        next if uri.hostname.nil?
        @allowed_hosts[uri.hostname.downcase] = true
        @allowed_hosts["#{uri.hostname.downcase}:#{uri.port}"] = true
      end
      @runners = operation_runners || {}
      @credential_hint = credential_hint || "Read the app's .agent-token file (mode 0600) in the project directory."
      @env = env
      # The served View's fingerprint (the wiring passes StaticView#version),
      # published as identity's `appVersion`: the marker that moves for a
      # View-only change, which schemaVersion is blind to. Re-derived per
      # call, same "derive, do not declare" rule.
      @app_version = app_version
      @audit_sink = audit || ->(entry) { @store.append_audit(entry) }
      @limiter = RateLimiter.new(DEFAULT_RATE_LIMITS.merge(rate_limits || {}), -> { now_ms })
      # `dataVersion` (see data_version) and the open tabs (see note_viewer),
      # both in memory: a restart moves the first and empties the second.
      @boot_mark = now_ms.to_s(36)
      @data_writes = 0
      @viewers = {}
      @state_lock = Mutex.new
      # A task action reads a task's state and writes the next one; under
      # Puma's threads that is one step, so two agents cannot both claim it.
      @task_lock = Mutex.new
      # Per app: browsers do not separate cookies by port, so two apps on one
      # machine would otherwise sign each other out.
      @session_cookie_name = "a2app_session_#{app_id}"
      @secure_cookies = !public_url.nil? && public_url.start_with?("https:")
      @sign_in_failures = Auth::FailureLimiter.new(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS, -> { now_ms })
      # Checks and writes that must be one step under Puma's threads: an
      # invite accepted twice, a device code redeemed twice, the last owner
      # demoted twice.
      @auth_lock = Mutex.new
      seed_admin_credential(token)
      prune_grants
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

    # Seed the admin credential from the app's own .agent-token, hashed on the
    # way in. Re-seeding at every boot follows a rotated token file: the old
    # token's hash is replaced under the same id.
    def seed_admin_credential(token)
      existing = @store.grant_by_id("cred_local")
      @store.put_grant(
        "credentialId" => "cred_local", "tokenHash" => Auth.hash_secret(token), "principal" => OWNER["id"],
        "agentName" => "local", "scopes" => ["*"],
        "createdAt" => existing ? existing["createdAt"] : now_iso, "expiresAt" => nil,
        "lastUsedAt" => existing ? existing["lastUsedAt"] : nil, "revokedAt" => nil, "task" => nil, "admin" => true
      )
    end

    # Revoked and expired credentials are kept a while so their tokens are
    # told why they stopped; after that they are gone.
    def prune_grants
      t = now_ms
      @store.list_grants.each do |g|
        ended = g["revokedAt"] || (g["expiresAt"] && ms_of(g["expiresAt"]) <= t ? g["expiresAt"] : nil)
        @store.delete_grant(g["credentialId"]) if ended && t - ms_of(ended) > GRANT_RETENTION_MS
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
        next if d["ownedBy"].nil?
        # The adapter writes the owner and the guard keeps clients from doing
        # so, which only holds for a declared, read-only string field.
        owner = d["fields"].find { |f| f["name"] == d["ownedBy"] }
        if owner.nil?
          problems << "entity \"#{name}\" is ownedBy \"#{d["ownedBy"]}\", which is not one of its fields"
        elsif owner["type"] != "string" || owner["readOnly"] != true
          problems << "entity \"#{name}\" is ownedBy \"#{d["ownedBy"]}\", which must be a readOnly string field"
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

    # The guard's 400: the first violation at the top level, every one in
    # `violations`.
    def guard_envelope(violations, server_now)
      first = violations[0]
      [400, {
        "a2app" => true, "ok" => false, "code" => first["code"], "field" => first["field"],
        "expected" => first["expected"], "got" => first["got"],
        "message" => describe_violation(first, server_now),
        "violations" => violations.map do |v|
          { "code" => v["code"], "field" => v["field"], "expected" => v["expected"], "got" => v["got"] }
        end,
      }]
    end
    private :guard_envelope

    # -- identity / describe ------------------------------------------------
    def identity
      t = Time.now
      doc = {
        "a2app" => true, "protocol" => PROTOCOL_VERSION, "adapterVersion" => ADAPTER_VERSION,
        "app" => { "id" => @app_id, "name" => @app_name }, "schemaVersion" => schema_version,
        # Moves on every record write. A View watcher compares it apart from
        # appVersion/schemaVersion so it can re-read data without reloading.
        "dataVersion" => data_version,
        "serverNow" => t.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ"), "serverTzOffsetMinutes" => t.utc_offset / 60,
        "authMode" => @auth_mode, "accountUrl" => ACCOUNT_URL,
      }
      doc["env"] = @env if @env.is_a?(String) && !@env.empty?
      # Published only when the app has one: a field that is sometimes empty
      # would make a client's "did it change?" comparison lie.
      version = @app_version.respond_to?(:call) ? @app_version.call : @app_version
      doc["appVersion"] = version if version.is_a?(String) && !version.empty?
      doc
    end

    # `dataVersion`: the marker that moves when RECORDS change, apart from the
    # two that move when the code does — a code change means an open page
    # must be replaced, a data change only that it must re-read. The boot
    # mark makes a restart count as a change: a server that came back up may
    # have been restored under a page still holding rows from before.
    def data_version
      @state_lock.synchronize { "#{@boot_mark}.#{@data_writes}" }
    end

    def mark_data_changed
      @state_lock.synchronize { @data_writes += 1 }
    end

    # Record a viewer's heartbeat, if this identity poll carried one: the
    # update watcher's opaque per-tab id, in a header on the poll, or in the
    # query for the goodbye a closing tab sends with sendBeacon (which cannot
    # carry headers). Only a COUNT is ever published — whether anyone is
    # looking, never who.
    def note_viewer(headers, query)
      id = headers.key?("x-a2app-viewer") ? headers["x-a2app-viewer"] : query["viewer"]
      return if !id.is_a?(String) || id.empty? || Js.length(id) > 64
      @state_lock.synchronize do
        if headers.key?("x-a2app-viewer-leaving") || query.key?("leaving")
          @viewers.delete(id)
        else
          @viewers[id] = now_ms
          # A reload is a fresh id, so the map would otherwise grow with every
          # reload of every tab.
          live_viewers if @viewers.length > VIEWER_CAP
        end
      end
    end

    # How many tabs are open, dropping the silent ones (the lock is held).
    def live_viewers
      cutoff = now_ms - VIEWER_TTL_MS
      @viewers.delete_if { |_id, seen| seen < cutoff }
      @viewers.length
    end
    private :live_viewers

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

    # A level's size in the units the budget is stated in: the length of its
    # JSON, counted as JavaScript counts it.
    def level_size(level)
      Js.length(Js.dump(level))
    end

    # Trim a list until the level fits, always reporting what was dropped.
    # Entries go from the end, so the order an app declared — editorial, the
    # most used first — decides what survives.
    def fit_list(items, &build)
      whole = build.call(items.dup, 0)
      return whole if level_size(whole) <= DESCRIBE_BUDGET_CHARS
      lo = 0
      hi = items.length
      while lo < hi
        mid = (lo + hi + 1) / 2
        if level_size(build.call(items[0, mid], items.length - mid)) <= DESCRIBE_BUDGET_CHARS
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

    ROOT_NEXT = ["describe/{module}", "describe?find={term}"].freeze

    # The app's home screen: what modules exist, how big each is, and whether
    # the caller can reach it. O(modules), never O(entities).
    def describe_root(access, show_all)
      modules = @modules.map do |m|
        owned = entities_of(m["name"])
        ops = @operations.select { |o| o["module"] == m["name"] }
        readable = owned.count { |n, _d| access["read"].call(n) }
        writable = owned.count { |n, _d| access["write"].call(n) }
        runnable = ops.count { |o| access["run"].call(o["name"]) }
        # An ops-only module is reachable when any of its operations is.
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

      build = lambda do |rows, truncated, summaries|
        level = {
          "level" => "root",
          "app" => { "id" => @app_id, "name" => @app_name },
          "modules" => summaries ? rows : rows.map { |r| r.except("summary") },
          "conventions" => self.class.conventions,
          "next" => truncated.positive? ? ROOT_NEXT + ["describe?all=true"] : ROOT_NEXT,
        }
        level["truncated"] = truncated if truncated.positive?
        level
      end

      return build.call(modules, 0, true) if show_all
      whole = build.call(modules, 0, true)
      return whole if level_size(whole) <= DESCRIBE_BUDGET_CHARS
      # Shed DETAIL before EXISTENCE: the summaries go first and every module
      # stays named; only if the bare names still do not fit are rows dropped,
      # counted, and returned by `?all=true`.
      bare = build.call(modules, 0, false)
      return bare if level_size(bare) <= DESCRIBE_BUDGET_CHARS
      fit_list(modules) { |rows, truncated| build.call(rows, truncated, false) }
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
        row = { "name" => o["name"] }
        row["destructive"] = o["destructive"] if o.key?("destructive")
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

    # The first level carrying schemas — and it carries them for one entity.
    # FIELDS ARE NEVER TRIMMED: a client treats a field absent from describe
    # as write-only and exempts it from the read-back check. Operations may
    # be, counted, since the module screen and search reach them too.
    def describe_entity(mod, name, d, access, show_all)
      fields = readable_fields(d).to_h { |f| [f["name"], field_doc(f)] }
      ops = []
      @operations.each do |o|
        next if o["entity"] != name || !access["run"].call(o["name"])
        decl = { "name" => o["name"] }
        decl["destructive"] = o["destructive"] if o.key?("destructive")
        decl["params"] = o["params"]
        decl["description"] = o["description"] if o["description"]
        decl["readOnly"] = true if o["readOnly"]
        decl["idempotent"] = true if o["idempotent"]
        decl["entity"] = name
        ops << decl
      end
      path = "#{mod}/#{name}"
      base_next = ["describe/#{path}/{id}", "data #{name} list"]
      build = lambda do |operations, truncated|
        level = {
          "level" => "entity",
          "path" => path,
          "label" => label_field_of(d["fields"]),
          "records" => "/api/collections/#{name}/records",
          "fields" => fields,
          "operations" => operations,
          "next" => base_next + (truncated.positive? ? ["describe/#{path}?all=true"] : []),
        }
        level["auth"] = true if d["auth"]
        level["ownedBy"] = d["ownedBy"] if d["ownedBy"]
        level["truncated"] = truncated if truncated.positive?
        level
      end
      show_all ? build.call(ops, 0) : fit_list(ops, &build)
    end

    # The parameter that takes THIS record, when an operation names one
    # unambiguously: exactly one required `ref` to this entity. The wire call
    # cannot see the record's path, so naming it lets a client fill it in
    # without guessing; two candidates (`from`, `to`) name nothing.
    def target_param_of(op, entity)
      candidates = (op["params"] || {}).select do |_name, p|
        p.is_a?(Hash) && p["type"] == "ref" && p["entity"] == entity && p["required"] == true
      end
      candidates.length == 1 ? candidates.keys[0] : nil
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
        target = target_param_of(o, name)
        row["targetParam"] = target unless target.nil?
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
        # A non-string label is stringified; absence stays null.
        "label" => label.is_a?(String) || label.nil? ? label : Js.string(label),
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
    # Parity oracle: `credentialOf`, `resolve`, `authorize` and `managerOf` in
    # adapters/adapter-core/src/server.ts. A caller is resolved in the order
    # spec/v0_2/auth.md §9 gives, and whatever reaches it is limited, on every
    # request, to what its principal may do at that moment (the ceiling, §3).

    # Who the caller is, and what it may do. `held` is the scopes it holds, or
    # :anonymous for an uncredentialled read on a single-user app, which the
    # scope check does not apply to.
    Caller = Struct.new(:ctx, :held, :grant)

    def multi_user?
      @auth_mode == "multi-user"
    end

    # Every scope the app declares: what `*` means.
    def all_scopes
      scopes = []
      @entity_defs.each_key do |name|
        scopes << "data:#{name}:read"
        scopes << "data:#{name}:write"
      end
      @operations.each { |o| scopes << "op:#{o["name"]}" }
      scopes
    end

    def expand_scopes(scopes)
      scopes.include?("*") ? all_scopes : scopes.uniq
    end

    # Who a principal is ({"id", "name", "role", "active"}), or nil when it is
    # unknown.
    def principal_info(id)
      return OWNER if id == OWNER["id"]
      return nil unless multi_user?
      a = @store.row("users", id)
      a && { "id" => a["id"], "name" => a["name"], "role" => a["role"], "active" => a["active"] }
    end

    # What a principal may do now (spec §3), or nil when it may do nothing.
    def permissions(info)
      return nil unless info && info["active"]
      expand_scopes(@permissions_of ? @permissions_of.call(info) : ["*"])
    end

    # The credential this request presents, checked in the order spec §9
    # gives: unknown, revoked (or its task is over), expired, then whether the
    # person it acts for may still act. Returns [[grant, info, held], nil] with
    # its effective reach — its own scopes intersected with the principal's —
    # or [nil, refusal]; [nil, nil] when no credential was presented.
    def credential_of(headers)
      token = headers["x-a2app-token"] || headers["x-lui-token"]
      return [nil, nil] if token.nil? || token.empty?
      grant = @store.grant_by_token_hash(Auth.hash_secret(token))
      t = now_ms
      unless grant
        return [nil, err(401, "credential_invalid", "This credential is not one this app issued.", "how" => RENEW_HINT)]
      end
      task = grant["task"].nil? ? nil : @store.get_task(grant["task"])
      if !grant["revokedAt"].nil? || (!grant["task"].nil? && (task.nil? || TERMINAL_TASK.include?(task["status"])))
        return [nil, err(401, "credential_revoked", "This credential was revoked.", "how" => RENEW_HINT)]
      end
      if !grant["expiresAt"].nil? && ms_of(grant["expiresAt"]) <= t
        return [nil, err(401, "token_expired", "This credential expired at #{grant["expiresAt"]}.", "how" => RENEW_HINT)]
      end
      info = principal_info(grant["principal"])
      allowed = permissions(info)
      if info.nil? || allowed.nil?
        return [nil, err(401, "principal_inactive", "The person this credential acts for is no longer active.")]
      end
      if grant["lastUsedAt"].nil? || t - ms_of(grant["lastUsedAt"]) >= LAST_USED_RESOLUTION_MS
        @store.put_grant(grant.merge("lastUsedAt" => iso_at(t)))
      end
      [[grant, info, expand_scopes(grant["scopes"]) & allowed], nil]
    end

    # The credential this request presents, if it is a usable one.
    def presented_grant(headers)
      presented, = credential_of(headers)
      presented && presented[0]
    end

    # The signed-in account behind this request's session cookie, as
    # {"key", "account"}, or nil. A deactivated account's session stops here.
    def session_of(headers)
      return nil unless multi_user?
      secret = Auth.parse_cookies(headers["cookie"])[@session_cookie_name]
      return nil if secret.nil? || secret.empty?
      key = Auth.hash_secret(secret)
      session = @store.row("sessions", key)
      return nil unless session
      if ms_of(session["expiresAt"]) <= now_ms
        @store.delete_row("sessions", key)
        return nil
      end
      account = @store.row("users", session["principal"])
      account && account["active"] ? { "key" => key, "account" => account } : nil
    end

    def foreign_origin?(headers)
      origin = headers["origin"]
      # No Origin: a program, not a browser.
      !origin.nil? && !@allowed_origins.key?(origin)
    end

    # True when the request carries one of the app's OWN origins.
    def is_same_origin(headers)
      origin = headers["origin"]
      !origin.nil? && @allowed_origins.key?(origin)
    end

    # Whether a request came from one of the app's own pages. Only ever used
    # to pick which 401 to send (sign in, or present a credential) and to let
    # the single-user View read — never to trust a change. A browser marks
    # same-origin fetches, GETs included, with Sec-Fetch-Site; a program sends
    # neither header.
    def from_own_page?(headers)
      is_same_origin(headers) || headers["sec-fetch-site"] == "same-origin"
    end

    def unauthenticated(headers, message)
      if multi_user? && from_own_page?(headers)
        return err(401, "sign_in_required", "Sign in to use this app.", "signInUrl" => "#{ACCOUNT_URL}#sign-in")
      end
      err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], message, "how" => @credential_hint)
    end

    # Who the caller is, in a fixed order: a foreign origin is refused; then
    # the agent credential; then, on a multi-user app, the session (a change
    # must come from the app's own page — CSRF, spec §4); on `authMode: none`,
    # the app's own View is the owner. Returns [Caller, nil] or [nil, refusal].
    def resolve(headers, is_write)
      if foreign_origin?(headers)
        return [nil, err(403, "forbidden_origin", "Refused: request Origin is not this app's own.")]
      end
      presented, refusal = credential_of(headers)
      return [nil, refusal] if refusal
      if presented
        grant, info, held = presented
        ctx = { "credentialId" => grant["credentialId"], "agentName" => grant["agentName"],
                "principal" => info["id"], "role" => info["role"] }
        return [Caller.new(ctx, held, grant), nil]
      end
      if multi_user?
        session = session_of(headers)
        if session
          if is_write && !is_same_origin(headers)
            return [nil, err(403, "forbidden_origin", "A signed-in change must come from this app's own page.")]
          end
          account = session["account"]
          ctx = { "credentialId" => "session", "agentName" => nil, "principal" => account["id"], "role" => account["role"] }
          return [Caller.new(ctx, permissions(principal_info(account["id"])) || [], nil), nil]
        end
        return [nil, unauthenticated(headers, "This app needs a credential.")]
      end
      # The app's own UI (same origin) is trusted: no credential needed. A
      # browser sends Origin only on a change; on a read it marks the request
      # with Sec-Fetch-Site, which a web page cannot forge. A local program
      # can, but on this mode it already reads everything without a
      # credential, so only a change is held to the stronger Origin rule.
      if is_same_origin(headers) || (!is_write && from_own_page?(headers))
        ctx = { "credentialId" => "ui", "agentName" => nil, "principal" => OWNER["id"], "role" => "owner" }
        return [Caller.new(ctx, permissions(OWNER) || [], nil), nil]
      end
      # A program write always needs a credential; an anonymous read on a
      # single-user app proceeds as the owner.
      return [nil, unauthenticated(headers, "This write requires an agent credential.")] if is_write
      [Caller.new({ "credentialId" => "anonymous", "agentName" => nil, "principal" => OWNER["id"], "role" => "owner" },
                  :anonymous, nil), nil]
    end

    # The fixed chain: origin -> credential -> scope. Returns [ctx, nil] on
    # success, or [nil, refusal].
    def authorize(headers, scope, is_write)
      caller, reply = resolve(headers, is_write)
      return [nil, reply] if reply
      if scope && caller.held != :anonymous && !caller.held.include?(scope)
        return [nil, err(403, ERROR_CODES["INSUFFICIENT_SCOPE"], "This credential does not hold #{scope}.",
                         "required" => scope)]
      end
      [caller.ctx, nil]
    end

    # The caller as a manager of accounts and credentials (spec §2.4): a
    # signed-in person, the app's own View on `authMode: none`, or the admin
    # credential — as [{"principal", "role"}, nil], or [nil, refusal]. An
    # agent's delegated credential is never one.
    def manager_of(headers, write)
      caller, reply = resolve(headers, write)
      return [nil, reply] if reply
      if caller.grant
        unless caller.grant["admin"]
          return [nil, err(403, "not_a_manager", "An agent's credential cannot manage accounts or credentials.")]
        end
        return [{ "principal" => OWNER["id"], "role" => "owner" }, nil]
      end
      if caller.ctx["credentialId"] == "anonymous"
        return [nil, unauthenticated(headers, "Managing this app needs a credential.")]
      end
      [{ "principal" => caller.ctx["principal"], "role" => caller.ctx["role"] }, nil]
    end

    # Where this app is reached, for links handed to a person. The Host header
    # has already passed the host check by the time a route runs.
    def public_origin(headers)
      return @public_url if @public_url
      host = headers["host"]
      host ? "http://#{host}" : (@own_origins[0] || "")
    end

    # Rate gate: keyed by the caller — its credential token, else the page's
    # origin, else "anon" — and over the limit answers 429 before any work.
    def rate_gate(headers, cls)
      # A token is a secret and the audit log is persisted, so the caller is
      # keyed by the token's hash, never the token.
      token = headers["x-a2app-token"] || headers["x-lui-token"]
      caller_id =
        if token && !token.empty? then "token:#{Auth.hash_secret(token)}"
        elsif headers["origin"] then "origin:#{headers["origin"]}"
        else "anon"
        end
      decision = @limiter.check(caller_id, cls)
      return nil if decision["allowed"]
      # A refusal comes before the credential is resolved, but stays
      # traceable: the caller key and the route class go in the audit log, so
      # a flood is visible afterwards.
      write_audit({ "credentialId" => caller_id, "agentName" => nil, "principal" => nil }, "rate:#{cls}", nil, "rejected",
                  ERROR_CODES["RATE_LIMITED"])
      err(429, ERROR_CODES["RATE_LIMITED"],
          "Rate limit exceeded (#{decision["limit"]} per window). Slow down and retry.",
          "retryAfterSeconds" => decision["retryAfterSeconds"])
    end

    # One audit entry: who (`ctx`, or nil before anyone was resolved), what
    # (`target`, the record id), and how it ended. Not served over HTTP.
    def write_audit(ctx, target, record_id, outcome, code = nil)
      entry = {
        "at" => now_iso, "credentialId" => ctx && ctx["credentialId"], "agentName" => ctx && ctx["agentName"],
        "principal" => ctx && ctx["principal"], "target" => target, "recordId" => record_id, "outcome" => outcome,
      }
      entry["code"] = code if code
      @audit_sink.call(entry)
    end

    # -- ownership (spec/v0_2/auth.md §5) -----------------------------------

    # Whether `ctx` sees only the records it owns in entity `d`.
    def owned_only?(d, ctx)
      multi_user? && !d["ownedBy"].nil? && ctx["role"] != "owner"
    end

    # The record if `ctx` may see it, else nil (another member's record is
    # indistinguishable from a missing one).
    def visible(d, ctx, rec)
      return nil if rec.nil?
      owned_only?(d, ctx) && rec[d["ownedBy"]] != ctx["principal"] ? nil : rec
    end

    # -- dispatch -----------------------------------------------------------

    NO_ACCESS = { "read" => ->(_e) { false }, "write" => ->(_e) { false }, "run" => ->(_o) { false } }.freeze

    # What this caller may do, for rendering access on a describe level.
    #
    # Mirrors `authorize`'s own precedence exactly, including its two
    # bypasses: the app's own UI and an anonymous read on a single-user app
    # both reach a context without meeting the scope check. The UI holds the
    # owner's permissions; an anonymous caller reads, and runs only read-only
    # operations — `authorize` answers its writes with a 401, so describe must
    # not tell it otherwise.
    def access_for(headers)
      caller, reply = resolve(headers, false)
      return NO_ACCESS if reply
      if caller.held == :anonymous
        return {
          "read" => ->(_e) { true },
          "write" => ->(_e) { false },
          "run" => ->(o) { @op_by_name[o] && @op_by_name[o]["readOnly"] == true },
        }
      end
      held = caller.held
      {
        "read" => ->(e) { held.include?("data:#{e}:read") },
        "write" => ->(e) { held.include?("data:#{e}:write") },
        "run" => ->(o) { held.include?("op:#{o}") },
      }
    end

    # The same reach, written as the scope names a grant would have carried —
    # how whoami answers a caller that holds no grant, rendered from the very
    # access describe uses so the two cannot disagree.
    def reach_as_scopes(access)
      scopes = []
      @entity_defs.each_key do |name|
        scopes << "data:#{name}:read" if access["read"].call(name)
        scopes << "data:#{name}:write" if access["write"].call(name)
      end
      @operations.each { |o| scopes << "op:#{o["name"]}" if access["run"].call(o["name"]) }
      scopes
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

      show_all = q["all"] == "true"
      return [200, describe_root(access, show_all)] if segments.empty?

      module_name = segments[0]
      mod = @modules.find { |m| m["name"] == module_name }
      if mod.nil?
        return err(404, "unknown_module", "No module \"#{module_name}\".",
                   "modules" => @modules.map { |m| m["name"] })
      end
      return [200, describe_module(mod, access, show_all)] if segments.length == 1

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
        return [200, describe_entity(module_name, entity, d, access, show_all)]
      end

      limited = rate_gate(headers, "data")
      return limited if limited
      ctx, reply = authorize(headers, "data:#{entity}:read", false)
      return reply if reply

      record_id = segments[2]
      record = visible(d, ctx, @store.get_record(entity, record_id))
      return err(404, "record_not_found", "No #{entity} record \"#{record_id}\".") if record.nil?
      return [200, describe_record(module_name, entity, d, record, access)] if segments.length == 3

      relation = segments[3]
      field = d["fields"].find do |f|
        f["name"] == relation && f["type"] == "list<ref>" && f["entity"] && !f["writeOnly"]
      end
      if field.nil?
        return err(404, "unknown_relation", "\"#{relation}\" is not a sub-resource of #{entity}.",
                   "relations" => d["fields"].select { |f| f["type"] == "list<ref>" && !f["writeOnly"] }.map { |f| f["name"] })
      end
      target = field["entity"]
      unless access["read"].call(target)
        return err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                   "This credential does not hold data:#{target}:read.",
                   "required" => "data:#{target}:read")
      end
      target_def = @entity_defs[target]
      target_label = target_def ? label_field_of(target_def["fields"]) : nil
      ids = record[relation]
      items = (ids.is_a?(Array) ? ids : []).map do |rid|
        referenced = @store.get_record(target, Js.string(rid))
        # A dangling reference is reported as the id it is, not dropped.
        label = referenced && target_label ? referenced[target_label] : nil
        { "id" => Js.string(rid), "label" => label.is_a?(String) || label.nil? ? label : Js.string(label) }
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

    def allowed_host?(raw)
      return true if @allowed_hosts.key?(raw.downcase)
      name = Network.hostname_of(raw)
      !name.nil? && (Network.loopback_name?(name) || @allowed_hosts.key?(name))
    end

    # The refusal for a request addressed to a host this app does not answer
    # to, or nil. Checked before any route, including the unauthenticated
    # identity document, which is otherwise a free fingerprint of the app for a
    # rebound page: binding loopback does not stop a page on evil.com whose
    # DNS re-resolves to 127.0.0.1, but its Host header still says evil.com.
    # The wiring asks the same question for the pages it serves itself.
    def host_refusal(headers)
      host = headers["host"]
      return nil if host.nil? || allowed_host?(host)
      err(403, "forbidden_host", %(Refused: this app answers only on its own host, not "#{host}".))
    end

    # Route one request: [status, payload], or [status, payload, headers] when
    # the reply sets a header of its own (the session cookie) — or nil for a
    # path outside the adapter's namespaces, which is the View's to answer.
    # `query` is the raw query string (or a Hash already read); `body` the
    # parsed JSON body (nil when there was none).
    #
    # Parity oracle: `handle` in adapters/adapter-core/src/server.ts. Path
    # segments are percent-decoded one by one, after splitting, so an escaped
    # `/` in a record id stays part of the id.
    def dispatch(method, path, headers, body, query = nil)
      headers = (headers || {}).to_h { |k, v| [k.to_s.downcase, v] }
      method = method.to_s.upcase
      q = query.is_a?(String) ? Js.parse_query(query) : (query || {}).to_h { |k, v| [k.to_s, v] }
      if path.include?("?")
        path, qs = path.split("?", 2)
        q = q.merge(Js.parse_query(qs))
      end
      path = path.sub(%r{/+\z}, "")
      path = "/" if path.empty?

      refused = host_refusal(headers)
      return refused if refused
      if ["/.well-known/a2app.json", "/api/_a2app"].include?(path)
        # The update watcher polls identity anyway, so its "this tab is still
        # open" rides along rather than doubling every tab's requests.
        note_viewer(headers, q)
        return [200, identity]
      end
      # How many tabs have this app open: a count only, and behind a
      # credential — not a fact for anyone who asks.
      if path == "/api/_a2app/viewers"
        _ctx, reply = authorize(headers, nil, false)
        return reply if reply
        return [200, { "a2app" => true, "viewers" => @state_lock.synchronize { live_viewers }, "ttlMs" => VIEWER_TTL_MS }]
      end
      # Describe is navigational: the bare path is the root level, and each
      # extra segment moves one level inward (A2APP-SPEC 3).
      return handle_describe(headers, [], q) if path == "/api/_a2app/describe"
      if path.start_with?("/api/_a2app/describe/")
        segments = path["/api/_a2app/describe/".length..].split("/", -1).map { |s| Js.decode_uri_component!(s) }
        if segments.length > 4
          return err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.")
        end
        return err(404, "usage", "describe path has an empty segment.") if segments.any? { |s| s == "" }
        return handle_describe(headers, segments, q)
      end
      if path == "/api/_a2app/whoami"
        # whoami answers whoever this app will actually serve, which is what
        # `authorize` decides — so it asks the same question. The 401 that
        # remains is the honest one: on a multi-user app, a caller with no
        # credential and no session really would be refused.
        caller, reply = resolve(headers, false)
        return reply if reply
        # The reach the request was given: a credential's scopes intersected
        # with what its person may do now, or a person's own. An anonymous
        # read on a single-user app was never scope-checked, so it reports
        # the reach describe renders for it — one source, so they agree.
        held = caller.held == :anonymous ? reach_as_scopes(access_for(headers)) : caller.held
        return [200, {
          "a2app" => true, "credentialId" => caller.ctx["credentialId"], "agentName" => caller.ctx["agentName"],
          "principal" => caller.ctx["principal"], "principalName" => principal_info(caller.ctx["principal"])&.fetch("name"),
          "role" => caller.ctx["role"], "expiresAt" => caller.grant && caller.grant["expiresAt"], "scopes" => held.sort,
        }]
      end
      if path.start_with?("/api/_a2app/auth/")
        # Unauthenticated by design (an agent starts here with nothing), so it
        # is metered like an operation before anything is looked up.
        limited = rate_gate(headers, "ops")
        return limited if limited
        reply = handle_device(method, path, headers, body)
        return reply if reply
      end
      if path == "/api/_a2app/credentials" || path.start_with?("/api/_a2app/credentials/")
        return handle_credentials(method, path, headers, body)
      end
      if %w[/api/_a2app/session /api/_a2app/invites /api/_a2app/users].any? { |p| path == p || path.start_with?("#{p}/") }
        return err(404, "not_multi_user", "This app has no accounts: its authMode is none.") unless multi_user?
        return handle_accounts(method, path, headers, body)
      end
      if path == "/api/_a2app/context"
        _ctx, reply = authorize(headers, nil, false)
        return reply if reply
        return [200, { "a2app" => true, "view" => nil, "selected" => [] }]
      end
      return handle_events(headers, q) if path == "/api/_a2app/events"
      if path == "/api/_a2app/tasks" || path.start_with?("/api/_a2app/tasks/")
        rest = path == "/api/_a2app/tasks" ? [] : path["/api/_a2app/tasks/".length..].split("/", -1)
        return handle_tasks(method, headers, rest, body, q)
      end

      m = %r{\A/api/collections/([^/]+)/records(?:/([^/]+))?\z}.match(path)
      if m
        return handle_records(method, headers, Js.decode_uri_component!(m[1]),
                              m[2] && Js.decode_uri_component!(m[2]), body, q)
      end

      m = %r{\A/api/ops/([^/]+)\z}.match(path)
      if m
        return err(405, "usage", "Operations are POST-only.") if method != "POST"
        return handle_operation(headers, Js.decode_uri_component!(m[1]), body)
      end

      # A miss in the adapter's own namespaces is the adapter's to answer; the
      # rest is the View's.
      return err(404, "not_found", UNKNOWN_ROUTE_MESSAGE) if ADAPTER_NAMESPACES.any? { |ns| path == ns || path.start_with?("#{ns}/") }
      nil
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
              ids << Js.string(row["id"] || "") if ids.length < REFERENCE_SCAN_LIMIT
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

    def handle_records(method, headers, entity, rec_id, raw_body, query)
      limited = rate_gate(headers, "data")
      return limited if limited
      d = @entity_defs[entity]
      return err(404, "unknown_entity", "No such entity \"#{entity}\".") unless d
      fields = d["fields"]
      server_now = now_iso

      if method == "GET"
        ctx, reply = authorize(headers, "data:#{entity}:read", false)
        return reply if reply
        if rec_id
          rec = visible(d, ctx, @store.get_record(entity, rec_id))
          return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".") unless rec
          return [200, rec]
        end
        # Only the list parameters the protocol defines pass through: a member
        # sees only its own records (`where`, applied before paging), and a
        # caller cannot supply a constraint of its own under that name.
        list_query = {}
        list_query["where"] = { d["ownedBy"] => ctx["principal"] } if owned_only?(d, ctx)
        list_query["filter"] = query["filter"] if query.key?("filter")
        list_query["sort"] = query["sort"] if query.key?("sort")
        list_query["perPage"] = Js.number(query["perPage"]) if query.key?("perPage")
        list_query["page"] = Js.number(query["page"]) if query.key?("page")
        begin
          return [200, @store.list_records(entity, list_query)]
        rescue UnsupportedFilter => e
          # Refuse, never ignore: unfiltered rows under a filter would be a
          # 200 with the wrong records (see the grammar's comment).
          return err(400, ERROR_CODES["INVALID_FILTER"], e.message, "got" => e.expression)
        end
      end

      ctx, reply = authorize(headers, "data:#{entity}:write", true)
      if reply
        write_audit(nil, "data:#{entity}", rec_id, "rejected", reply[1]["code"])
        return reply
      end

      if method == "DELETE"
        return err(400, "usage", "DELETE requires a record id.") unless rec_id
        if owned_only?(d, ctx) && !visible(d, ctx, @store.get_record(entity, rec_id))
          return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".")
        end

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
          write_audit(ctx, "data:#{entity}", rec_id, "rejected", ERROR_CODES["RECORD_REFERENCED"])
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
        write_audit(ctx, "data:#{entity}", rec_id, ok ? "ok" : "rejected")
        return err(404, "record_not_found", "No #{entity} record \"#{rec_id}\".") unless ok
        mark_data_changed
        return [200, { "a2app" => true, "ok" => true, "deleted" => rec_id }]
      end

      return err(405, "usage", "#{method} not allowed on records.") unless %w[POST PATCH].include?(method)

      body = object_view(raw_body)
      # Idempotency, on a create (scoped to the entity) and on an update
      # (scoped to the record, so a retried update after a lost response does
      # not re-apply). Checked before the guard; a key is recorded only after
      # a write that read back whole.
      idem_key = headers["idempotency-key"]
      idem_active = !idem_key.nil? && !idem_key.empty? && (method == "POST" || !rec_id.nil?)
      idem_scope = method == "PATCH" ? "#{entity}##{rec_id}" : entity
      if idem_active && (prior = @store.idem_get(idem_scope, idem_key))
        return err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key was already applied.", "id" => prior)
      end

      # The guard reads the RAW body, before any coercion. Required fields
      # are enforced on a create only — an update is a legitimate partial
      # write.
      allow = (d["writeAllow"] || []).to_h { |k| [k, true] }
      violations = validate(fields, body, allow: allow, require_required: method == "POST")
      unless violations.empty?
        write_audit(ctx, "data:#{entity}", rec_id, "rejected", violations[0]["code"])
        return guard_envelope(violations, server_now)
      end

      if method == "POST"
        # The owner field is the adapter's to set: the guard has already
        # refused a client that tried, because it is read-only.
        stored = @store.put_record(entity, materialize(entity, d["ownedBy"] ? body.merge(d["ownedBy"] => ctx["principal"]) : body))
      else
        return err(400, "usage", "PATCH requires a record id.") unless rec_id
        existing = visible(d, ctx, @store.get_record(entity, rec_id))
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
        stored = @store.put_record(entity, existing)
      end

      # Read-back: did every non-blank requested value land?
      lost = divergences(fields, body, ->(n) { stored[n] })
      unless lost.empty?
        write_audit(ctx, "data:#{entity}", stored["id"], "rejected", ERROR_CODES["NOT_STORED"])
        return [422, {
          "a2app" => true, "ok" => false, "code" => ERROR_CODES["NOT_STORED"],
          "message" => describe_incomplete(lost),
          "violations" => lost.map { |l| { "code" => ERROR_CODES["NOT_STORED"], "field" => l["field"] } },
          "id" => stored["id"],
        }]
      end

      @store.idem_put(idem_scope, idem_key, stored["id"]) if idem_active
      write_audit(ctx, "data:#{entity}", stored["id"], "ok")
      mark_data_changed
      [200, stored]
    end

    # -- operations ---------------------------------------------------------

    # A declared operation's parameters, as the fields the guard validates. An
    # operation IS a write — often a destructive one — so its arguments meet
    # the same rules as a record write rather than a second, weaker path.
    def param_fields(decl)
      (decl["params"] || {}).map do |name, p|
        field = { "name" => name, "type" => p["type"] }
        %w[required max values entity].each { |k| field[k] = p[k] if p.key?(k) }
        field
      end
    end

    def handle_operation(headers, name, raw_args)
      limited = rate_gate(headers, "ops")
      return limited if limited
      decl = @op_by_name[name]
      return err(404, "unknown_operation", "No declared operation \"#{name}\".") unless decl
      ctx, reply = authorize(headers, "op:#{name}", !decl["readOnly"])
      return reply if reply
      args = object_view(raw_args)

      # Guard the RAW args before anything acts on them, and before an
      # approval key is minted: a person must never be asked to approve a call
      # that cannot run. Every parameter is supplied fresh on each call, so a
      # declared `required` is always enforced.
      violations = validate(param_fields(decl), args, require_required: true)
      unless violations.empty?
        write_audit(ctx, "op:#{name}", nil, "rejected", violations[0]["code"])
        return guard_envelope(violations, now_iso)
      end

      # A retried call carrying the same Idempotency-Key must not run twice.
      # Checked before approval; recorded only after a success, so a first
      # call that asked for approval (or threw) leaves the retry free to run.
      idem_key = headers["idempotency-key"]
      idem_key = nil if idem_key&.empty?
      idem_scope = "op:#{name}"
      if idem_key && @store.idem_get(idem_scope, idem_key)
        return err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key already ran this operation.",
                   "operation" => name)
      end

      # A destructive call needs a person's approval of this exact call: the
      # key is content-addressed, single use, and lives 10 minutes.
      if decl["destructive"]
        key = approval_key(name, raw_args)
        provided = headers["x-a2app-approval"] || headers["x-lui-approval"]
        if provided.nil? || provided.empty?
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
        # `ctx` is the caller ({"credentialId", "agentName", "principal",
        # "role"}): a runner holds itself to the same ownership rule as the
        # records API. A task it queues is done by an agent acting as them.
        result = runner.call(args, ctx, CallerStore.new(@store, ctx["principal"]))
        @store.idem_put(idem_scope, idem_key, name) if idem_key
        # Only a declared read-only operation promises it changed nothing; the
        # adapter cannot see inside the runner, so anything else counts as a
        # data change — a needless re-read beats a stale page.
        mark_data_changed unless decl["readOnly"] == true
        write_audit(ctx, "op:#{name}", nil, "ok")
        [200, { "a2app" => true, "ok" => true, "operation" => name, "result" => result }]
      rescue OperationError => e
        write_audit(ctx, "op:#{name}", nil, "rejected", e.code)
        err(e.http_status, e.code, e.message, e.extra || {})
      rescue StandardError => e
        write_audit(ctx, "op:#{name}", nil, "rejected", "operation_failed")
        err(500, "operation_failed", "Operation \"#{name}\" threw: #{e.message}")
      end
    end

    # -- tasks / events -----------------------------------------------------
    def handle_events(headers, query)
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

    def handle_tasks(method, headers, rest, raw_body, query)
      limited = rate_gate(headers, "data")
      return limited if limited
      caller, reply = resolve(headers, method != "GET")
      return reply if reply
      @task_lock.synchronize { task_request(method, headers, rest, object_view(raw_body), query, caller) }
    end

    # A task holds who asked and what was asked and answered, so it is
    # reached like a record (spec/v0_2/auth.md §6.3): an owner reaches every
    # task, a task credential its own, anyone else the tasks they queued.
    def reaches_task?(caller, task)
      bound = caller.grant && caller.grant["task"]
      return bound == task["id"] if bound
      caller.ctx["role"] == "owner" || task["request"]["principal"] == caller.ctx["principal"]
    end

    # Progress and completion come from whoever runs the task: an owner, the
    # task's own credential, or the credential that holds its claim.
    def runs_task?(caller, task)
      ctx = caller.ctx
      claim = task["claim"]
      ctx["role"] == "owner" || (!caller.grant.nil? && caller.grant["task"] == task["id"]) ||
        (!claim.nil? && claim["credentialId"] == ctx["credentialId"] && claim["principal"] == ctx["principal"])
    end

    # One tasks request, its caller already resolved.
    def task_request(method, headers, rest, body, query, caller)
      ctx = caller.ctx
      @store.sweep(TASK_TIMEOUT_MS, TASK_MAX_DELIVERIES)

      if rest.empty? && method == "GET"
        tasks = @store.list_tasks(query["status"]).select { |t| reaches_task?(caller, t) }
        return [200, { "a2app" => true, "tasks" => tasks.map { |t| self.class.task_wire(t) }, "pollAfterMs" => 2000 }]
      end
      task_id = rest[0]
      return err(400, "usage", "Task id required.") if task_id.nil? || task_id.empty?
      action = rest[1]
      # A task out of reach answers as one that does not exist: its existence
      # is itself something the caller may not learn.
      task = @store.get_task(task_id)
      unless task && reaches_task?(caller, task)
        return err(404, ERROR_CODES["TASK_NOT_FOUND"], "No task \"#{task_id}\".")
      end
      return [200, self.class.task_wire(task)] if action.nil? && method == "GET"
      return err(405, "usage", "#{method} not allowed here.") if method != "POST"

      case action
      when "claim"
        if task["status"] != "submitted"
          write_audit(ctx, "task:claim", task_id, "rejected", ERROR_CODES["TASK_NOT_CLAIMABLE"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} is #{task["status"]}, not claimable.")
        end
        # A body naming who claims is honoured only when it names the caller
        # itself; naming anyone else is a claim-as-someone-else, refused
        # rather than quietly recorded as the true caller.
        requested = body["agent"].is_a?(String) && !body["agent"].empty? ? body["agent"] : nil
        if requested && requested != ctx["credentialId"] && requested != ctx["agentName"]
          write_audit(ctx, "task:claim", task_id, "rejected", "principal_mismatch")
          return err(403, "principal_mismatch",
                     "Cannot claim task #{task_id} as \"#{requested}\": the credential presented is #{ctx["credentialId"]}.",
                     "requested" => requested, "actual" => ctx["credentialId"])
        end
        task["status"] = "working"
        task["claim"] = { "credentialId" => ctx["credentialId"], "principal" => ctx["principal"],
                          "claimedAt" => now_iso }
        @store.save_task(task)
        write_audit(ctx, "task:claim", task_id, "ok")
        [200, self.class.task_wire(task)]
      when "progress"
        return err(409, ERROR_CODES["TASK_CANCELED"], "Task #{task_id} was canceled.") if task["status"] == "canceled"
        unless %w[working input-required].include?(task["status"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} is #{task["status"]}.")
        end
        return task_not_held(ctx, action, task_id) unless runs_task?(caller, task)
        task["progress"]["step"] = body["step"] if body["step"].is_a?(String)
        task["progress"]["percent"] = body["percent"] if body["percent"].is_a?(Numeric)
        # `ask` present, even null, is a question for the person.
        if body.key?("ask")
          task["ask"] = body["ask"]
          task["status"] = "input-required"
        elsif task["status"] == "input-required"
          task["status"] = "working"
        end
        @store.save_task(task)
        write_audit(ctx, "task:progress", task_id, "ok")
        [200, self.class.task_wire(task)]
      when "complete"
        return err(409, ERROR_CODES["TASK_CANCELED"], "Task #{task_id} was canceled.") if task["status"] == "canceled"
        # A terminal write belongs to a live claim. Once the sweeper has returned
        # a task to the queue, a late completion from the run that abandoned it
        # must not close work someone else may now be doing.
        unless %w[working input-required].include?(task["status"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} is #{task["status"]}, not in progress.")
        end
        return task_not_held(ctx, action, task_id) unless runs_task?(caller, task)
        case body["status"]
        when "completed"
          task["status"] = "completed"
          task["result"] = body["result"].nil? ? {} : body["result"]
        when "failed"
          task["status"] = "failed"
          task["reason"] = body["reason"].is_a?(String) ? body["reason"] : "unspecified"
        else
          return err(400, "usage", 'complete requires status "completed" or "failed".')
        end
        @store.save_task(task)
        write_audit(ctx, "task:complete", task_id, "ok", task["status"] == "failed" ? "failed" : nil)
        [200, self.class.task_wire(task)]
      when "cancel"
        # Terminal is terminal: relabelling finished work as canceled would
        # rewrite the recorded outcome.
        if TERMINAL_TASK.include?(task["status"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} already reached #{task["status"]}.")
        end
        task["status"] = "canceled"
        @store.save_task(task)
        write_audit(ctx, "task:cancel", task_id, "ok")
        [200, self.class.task_wire(task)]
      when "credential"
        # What the bridge runs the task's harness with (spec/v0_2/auth.md
        # §6.2): the person who queued it, the capability's scopes, and no
        # life past the task.
        manager, reply = manager_of(headers, true)
        return reply if reply
        return err(403, "not_a_manager", "Only an owner issues a task's credential.") if manager["role"] != "owner"
        if TERMINAL_TASK.include?(task["status"])
          return err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], "Task #{task_id} already reached #{task["status"]}.")
        end
        principal = task["request"]["principal"] || OWNER["id"]
        info = principal_info(principal)
        unless info && info["active"]
          return err(401, "principal_inactive", "The person who queued this task is no longer active.")
        end
        agent_name, problem = parse_agent_name(body["agentName"])
        return err(400, "usage", problem) if problem
        token, grant = mint_credential(
          principal, agent_name, @capabilities.dig(task["request"]["capability"], "scopes") || ["*"],
          TASK_CREDENTIAL_SECONDS, task: task["id"]
        )
        write_audit(ctx, "task:credential", task_id, "ok")
        [201, { "a2app" => true, "token" => token, "credential" => credential_wire(grant, info["name"]) }]
      else
        err(404, "usage", "Unknown task action \"#{action}\".")
      end
    end

    # Progress or completion from someone who reaches the task but does not
    # run it: refused, and audited like the other task refusals.
    def task_not_held(ctx, action, task_id)
      write_audit(ctx, "task:#{action}", task_id, "rejected", ERROR_CODES["TASK_NOT_HELD"])
      err(403, ERROR_CODES["TASK_NOT_HELD"],
          "Task #{task_id} is held by another credential; only the run that holds it reports on it.")
    end

    # A task as served: who asked, its claim and progress — never its `ask`,
    # delivery count or dedup key.
    def self.task_wire(t)
      {
        "id" => t["id"], "app" => t["app"], "event" => t["event"], "status" => t["status"],
        "request" => t["request"].merge("principal" => t["request"]["principal"]), "claim" => t["claim"],
        "progress" => t["progress"], "result" => t["result"], "reason" => t["reason"],
        "createdAt" => t["createdAt"], "updatedAt" => t["updatedAt"], "pollAfterMs" => 2000,
      }
    end

    # -- accounts and sessions (spec/v0_2/auth.md §4; multi-user only) -------
    #
    #   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
    #   POST /api/_a2app/invites                    a one-time setup link (owner manager)
    #   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
    #   GET /api/_a2app/users                       every account (owner manager)
    #   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
    #
    # Accounts are adapter state, never records: they are not served by the
    # records API, and a password hash never leaves this section. Parity
    # oracle: adapters/adapter-core/src/accounts.ts.

    # The account as served: never its password hash.
    def account_wire(a)
      { "id" => a["id"], "name" => a["name"], "login" => a["login"], "role" => a["role"],
        "active" => a["active"], "createdAt" => a["createdAt"] }
    end

    def accounts
      @store.rows_of("users").map { |_key, a| a }
    end

    def account_by_login(login)
      accounts.find { |a| a["login"] == login }
    end

    def active_owners
      accounts.select { |a| a["role"] == "owner" && a["active"] }
    end

    def start_session(account, status)
      secret = Auth.new_secret
      created = now_ms
      @store.put_row("sessions", Auth.hash_secret(secret), {
        "principal" => account["id"], "createdAt" => iso_at(created), "expiresAt" => iso_at(created + SESSION_TTL_MS),
      })
      cookie = Auth.session_cookie(@session_cookie_name, secret, max_age_seconds: SESSION_TTL_MS / 1000, secure: @secure_cookies)
      [status, { "a2app" => true }.merge(account_wire(account)), { "set-cookie" => cookie }]
    end

    # The reason `body` is not a valid new account, or nil.
    def account_problem(body)
      name, login, password = body.values_at("name", "login", "password")
      if !name.is_a?(String) || Js.trim(name).empty? || Js.length(Js.trim(name)) > NAME_MAX
        return "name must be 1–#{NAME_MAX} characters."
      end
      if !login.is_a?(String) || Auth.normalize_login(login).empty? || Js.length(Auth.normalize_login(login)) > LOGIN_MAX
        return "login must be 1–#{LOGIN_MAX} characters."
      end
      if !password.is_a?(String) || Js.length(password) < Auth::PASSWORD_MIN || Js.length(password) > Auth::PASSWORD_MAX
        return "password must be #{Auth::PASSWORD_MIN}–#{Auth::PASSWORD_MAX} characters."
      end
      nil
    end

    # The live invite for `code` as {"key", "invite"}, or nil; an expired one
    # is dropped on the way.
    def live_invite(code)
      key = Auth.hash_secret(code)
      invite = @store.row("invites", key)
      return nil unless invite
      if ms_of(invite["expiresAt"]) <= now_ms
        @store.delete_row("invites", key)
        return nil
      end
      { "key" => key, "invite" => invite }
    end

    def handle_session(method, headers, body)
      if method == "GET"
        session = session_of(headers)
        return err(401, "sign_in_required", "Not signed in.", "signInUrl" => "#{ACCOUNT_URL}#sign-in") unless session
        return [200, { "a2app" => true }.merge(account_wire(session["account"]))]
      end
      if method == "DELETE"
        session = session_of(headers)
        @store.delete_row("sessions", session["key"]) if session
        cleared = Auth.session_cookie(@session_cookie_name, "", max_age_seconds: 0, secure: @secure_cookies)
        return [200, { "a2app" => true, "ok" => true }, { "set-cookie" => cleared }]
      end
      return err(405, "usage", "#{method} not allowed on the session.") unless method == "POST"

      unless body["login"].is_a?(String) && body["password"].is_a?(String)
        return err(400, "usage", "Sign in with { login, password }.")
      end
      login = Auth.normalize_login(body["login"])
      wait = @sign_in_failures.retry_after(login)
      if wait.positive?
        return err(429, "rate_limited", "Too many failed sign-ins for this login. Try again later.",
                   "retryAfterSeconds" => wait)
      end
      account = account_by_login(login)
      if account
        matches = Auth.verify_password(body["password"], account["passwordHash"])
      else
        # Checked against when a login does not exist, so a missing account
        # takes as long to refuse as a wrong password and the timing does not
        # say which.
        @dummy_hash ||= Auth.hash_password(Auth.new_secret)
        Auth.verify_password(body["password"], @dummy_hash)
        matches = false
      end
      if !account || !matches || !account["active"]
        @sign_in_failures.fail(login)
        return err(401, "sign_in_failed", "That login and password do not match an active account.")
      end
      @sign_in_failures.reset(login)
      start_session(account, 200)
    end

    def handle_invites(method, headers, body, code)
      if code.nil?
        return err(405, "usage", "#{method} not allowed on invites.") unless method == "POST"
        manager, reply = manager_of(headers, true)
        return reply if reply
        return err(403, "not_a_manager", "Only an owner can invite people.") if manager["role"] != "owner"
        role = body["role"].nil? ? "member" : body["role"]
        return err(400, "usage", 'role is "owner" or "member".') unless %w[owner member].include?(role)
        secret = Auth.new_secret
        created = now_ms
        invite = { "role" => role, "createdAt" => iso_at(created), "expiresAt" => iso_at(created + INVITE_TTL_MS) }
        @store.put_row("invites", Auth.hash_secret(secret), invite)
        return [201, {
          "a2app" => true, "code" => secret, "url" => "#{public_origin(headers)}#{ACCOUNT_URL}#setup/#{secret}",
          "role" => invite["role"], "expiresAt" => invite["expiresAt"],
        }]
      end

      invalid = "This invite link is not valid: it was used, or it expired."
      found = live_invite(code)
      return err(404, "invite_invalid", invalid) unless found
      if method == "GET"
        return [200, { "a2app" => true, "role" => found["invite"]["role"], "expiresAt" => found["invite"]["expiresAt"] }]
      end
      return err(405, "usage", "#{method} not allowed on an invite.") unless method == "POST"

      problem = account_problem(body)
      return err(400, "usage", problem) if problem
      login = Auth.normalize_login(body["login"])
      return err(409, "login_taken", "That login is already in use.") if account_by_login(login)
      password_hash = Auth.hash_password(body["password"])
      # The checks and the write are one step: a second acceptance of the same
      # invite, or a second account racing for the same login, sees this one's
      # result.
      @auth_lock.synchronize do
        still = live_invite(code)
        return err(404, "invite_invalid", invalid) unless still
        return err(409, "login_taken", "That login is already in use.") if account_by_login(login)
        account = {
          "id" => Auth.new_id("usr"), "name" => Js.trim(body["name"]), "login" => login,
          "role" => still["invite"]["role"], "active" => true, "createdAt" => iso_at(now_ms),
          "passwordHash" => password_hash,
        }
        @store.delete_row("invites", still["key"])
        @store.put_row("users", account["id"], account)
        start_session(account, 201)
      end
    end

    def handle_users(method, headers, body, id)
      manager, reply = manager_of(headers, method != "GET")
      return reply if reply
      return err(403, "not_a_manager", "Only an owner can manage people.") if manager["role"] != "owner"

      if id.nil?
        return err(405, "usage", "#{method} not allowed on users.") unless method == "GET"
        return [200, { "a2app" => true, "users" => accounts.sort_by { |a| a["createdAt"] }.map { |a| account_wire(a) } }]
      end
      return err(405, "usage", "#{method} not allowed on a user.") unless method == "PATCH"
      # One step, so two owners demoting each other cannot both pass the
      # last-owner check.
      @auth_lock.synchronize do
        account = @store.row("users", id)
        return err(404, "not_found", "No account \"#{id}\".") unless account
        if body.key?("active") && body["active"] != true && body["active"] != false
          return err(400, "usage", "active is true or false.")
        end
        if body.key?("role") && !%w[owner member].include?(body["role"])
          return err(400, "usage", 'role is "owner" or "member".')
        end
        changed = account.merge(body.slice("active", "role"))
        loses_owner = account["role"] == "owner" && account["active"] && (changed["role"] != "owner" || !changed["active"])
        if loses_owner && active_owners.length == 1
          return err(409, "last_owner", "This is the last active owner. Make someone else an owner first.")
        end
        @store.put_row("users", changed["id"], changed)
        [200, { "a2app" => true }.merge(account_wire(changed))]
      end
    end

    # Route one request under /api/_a2app/{session,invites,users}.
    def handle_accounts(method, path, headers, body)
      body = body.is_a?(Hash) ? body : {}
      return handle_session(method, headers, body) if path == "/api/_a2app/session"
      return handle_invites(method, headers, body, nil) if path == "/api/_a2app/invites"
      return handle_invites(method, headers, body, Js.decode_uri_component!(path["/api/_a2app/invites/".length..])) if path.start_with?("/api/_a2app/invites/")
      return handle_users(method, headers, body, nil) if path == "/api/_a2app/users"
      handle_users(method, headers, body, Js.decode_uri_component!(path["/api/_a2app/users/".length..]))
    end

    # -- credentials (spec/v0_2/auth.md §2, §8) -----------------------------
    #
    #   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
    #   POST /api/_a2app/credentials         issue one; the token is in this reply only
    #   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)
    #
    # Every credential this app issues is made by `mint_credential`: a 256-bit
    # token returned once, stored as its SHA-256, bound to one principal,
    # always expiring. Whatever its scopes say, each request it makes is
    # limited to what that principal may do at the time (`credential_of`).
    # Parity oracle: adapters/adapter-core/src/credentials.ts.

    # A credential as listed: never its token or the token's hash.
    def credential_wire(g, principal_name)
      { "credentialId" => g["credentialId"], "principal" => g["principal"], "principalName" => principal_name,
        "agentName" => g["agentName"], "scopes" => g["scopes"], "createdAt" => g["createdAt"],
        "expiresAt" => g["expiresAt"], "lastUsedAt" => g["lastUsedAt"], "task" => g["task"] }
    end

    # Issue a credential: store its hash, return [token (once), grant].
    def mint_credential(principal, agent_name, scopes, expires_in_seconds, task: nil)
      token = Auth.new_token
      t = now_ms
      grant = {
        "credentialId" => Auth.new_id("cred"), "tokenHash" => Auth.hash_secret(token), "principal" => principal,
        "agentName" => agent_name, "scopes" => scopes, "createdAt" => iso_at(t),
        "expiresAt" => iso_at(t + expires_in_seconds * 1000), "lastUsedAt" => nil, "revokedAt" => nil,
        "task" => task, "admin" => false,
      }
      @store.put_grant(grant)
      [token, grant]
    end

    # The optional agent name a caller gave a credential, checked:
    # [name or nil, nil] or [nil, problem].
    def parse_agent_name(value)
      return [nil, nil] if value.nil?
      if !value.is_a?(String) || Js.trim(value).empty? || Js.length(value) > 100
        return [nil, "agentName is 1–100 characters."]
      end
      [Js.trim(value), nil]
    end

    # The scopes and lifetime a caller asked for, checked: [{"scopes",
    # "expiresInSeconds"}, nil], or [nil, the reason they cannot be granted].
    # `scopes` defaults to `*`; every entry must be `*` or a scope the app
    # declares.
    def parse_grant_request(body)
      scopes = body["scopes"].nil? ? ["*"] : body["scopes"]
      if !scopes.is_a?(Array) || scopes.empty? || !scopes.all? { |s| s.is_a?(String) }
        return [nil, 'scopes is a non-empty list of scope names (or ["*"]).']
      end
      declared = all_scopes
      unknown = scopes.reject { |s| s == "*" || declared.include?(s) }
      return [nil, "Not scopes this app declares: #{unknown.join(", ")}."] unless unknown.empty?
      expires_in = body["expiresIn"].nil? ? DEFAULT_EXPIRES_SECONDS : body["expiresIn"]
      # A JSON number with no fraction is whole, whichever way the parser typed it.
      whole = expires_in.is_a?(Integer) || (expires_in.is_a?(Float) && expires_in.finite? && expires_in == expires_in.floor)
      unless whole && expires_in >= MIN_EXPIRES_SECONDS && expires_in <= MAX_EXPIRES_SECONDS
        return [nil, "expiresIn is a whole number of seconds from #{MIN_EXPIRES_SECONDS} to #{MAX_EXPIRES_SECONDS} (365 days)."]
      end
      [{ "scopes" => scopes.uniq, "expiresInSeconds" => expires_in.to_i }, nil]
    end

    # Still able to make a request: not revoked, not expired, its task not over.
    def live_grant?(g)
      return false if g["admin"] || !g["revokedAt"].nil?
      return false if !g["expiresAt"].nil? && ms_of(g["expiresAt"]) <= now_ms
      unless g["task"].nil?
        task = @store.get_task(g["task"])
        return false if task.nil? || TERMINAL_TASK.include?(task["status"])
      end
      true
    end

    def list_credentials(headers)
      manager, reply = manager_of(headers, false)
      return reply if reply
      credentials = @store.list_grants
                          .select { |g| live_grant?(g) && (manager["role"] == "owner" || g["principal"] == manager["principal"]) }
                          .sort_by { |g| g["createdAt"] }.reverse
                          .map { |g| credential_wire(g, principal_info(g["principal"])&.fetch("name")) }
      [200, { "a2app" => true, "credentials" => credentials }]
    end

    def issue_credential(headers, body)
      manager, reply = manager_of(headers, true)
      return reply if reply
      principal = body["principal"].nil? ? manager["principal"] : body["principal"]
      return err(400, "usage", 'principal is an account id (or "owner").') unless principal.is_a?(String)
      if principal != manager["principal"] && manager["role"] != "owner"
        return err(403, "not_a_manager", "Only an owner can issue a credential for someone else.")
      end
      info = principal_info(principal)
      return err(400, "usage", "\"#{principal}\" is not an active account of this app.") unless info && info["active"]
      agent_name, problem = parse_agent_name(body["agentName"])
      return err(400, "usage", problem) if problem
      parsed, problem = parse_grant_request(body)
      return err(400, "usage", problem) if problem
      token, grant = mint_credential(principal, agent_name, parsed["scopes"], parsed["expiresInSeconds"])
      [201, { "a2app" => true, "token" => token, "credential" => credential_wire(grant, info["name"]) }]
    end

    def revoke_credential(headers, id)
      grant = @store.grant_by_id(id)
      return err(404, "not_found", "No credential \"#{id}\".") unless grant
      if grant["admin"]
        return err(403, "not_a_manager", "The admin credential is the app's .agent-token: rotate that file instead.")
      end
      # A credential may always revoke itself — the one thing an agent may do
      # with credentials — so an agent can hand back access it no longer needs.
      unless presented_grant(headers)&.fetch("credentialId") == id
        manager, reply = manager_of(headers, true)
        return reply if reply
        if manager["role"] != "owner" && grant["principal"] != manager["principal"]
          return err(404, "not_found", "No credential \"#{id}\".")
        end
      end
      @store.put_grant(grant.merge("revokedAt" => now_iso)) if grant["revokedAt"].nil?
      [200, { "a2app" => true, "ok" => true, "revoked" => id }]
    end

    # Route one request under /api/_a2app/credentials.
    def handle_credentials(method, path, headers, body)
      body = body.is_a?(Hash) ? body : {}
      if path == "/api/_a2app/credentials"
        return list_credentials(headers) if method == "GET"
        return issue_credential(headers, body) if method == "POST"
        return err(405, "usage", "#{method} not allowed on credentials.")
      end
      return err(405, "usage", "A credential is revoked with DELETE.") unless method == "DELETE"
      revoke_credential(headers, Js.decode_uri_component!(path["/api/_a2app/credentials/".length..]))
    end

    # -- device-code sign-in (spec/v0_2/auth.md §7, RFC 8628 shape) ----------
    #
    #   POST /api/_a2app/auth/device               an agent asks; gets a code to show
    #   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
    #   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
    #   POST /api/_a2app/auth/token                 the agent polls; gets its credential
    #
    # The person approves on the app's own account page, signed in as
    # themselves; the credential issued acts for them, with the scopes they
    # approved. No password or session ever reaches the agent. Codes live 10
    # minutes, are single use, and the device code is stored only as its hash.
    #
    # Approving is not enough on its own: anyone can start a request and send
    # the person its link. So approval issues a one-time confirmation code
    # (stored only as its hash), and the credential goes only to the poll that
    # presents it. An agent on the person's own computer receives it on a
    # loopback port (RFC 8252) when the account page sends the browser back
    # there; an agent elsewhere is given it by the person.
    # Parity oracle: adapters/adapter-core/src/device.ts.

    # Live rows as [key, row] pairs, dropping the expired as it goes.
    def live_devices
      t = now_ms
      live, expired = @store.rows_of("devices").partition { |_key, row| ms_of(row["expiresAt"]) > t }
      expired.each { |key, _row| @store.delete_row("devices", key) }
      live
    end

    # The pending request a person typed the code of, as [key, row], or nil.
    def device_by_user_code(input)
      code = Auth.normalize_user_code(input)
      return nil if code.empty?
      live_devices.find { |_key, row| row["userCode"] == code && row["status"] == "pending" }
    end

    def start_device(headers, body)
      parsed, problem = parse_grant_request(body)
      return err(400, "usage", problem) if problem
      agent_name = body["agentName"]
      if body.key?("agentName") &&
         (!agent_name.is_a?(String) || Js.trim(agent_name).empty? || Js.length(agent_name) > 100)
        return err(400, "usage", "agentName is 1–100 characters.")
      end
      # A whole number in range, however the JSON wrote it (53682 or 53682.0).
      port = body["loopbackPort"]
      unless port.nil? || (port.is_a?(Numeric) && port == port.to_i && LOOPBACK_PORTS.cover?(port))
        return err(400, "usage", "loopbackPort is the port, #{LOOPBACK_PORTS.min} to #{LOOPBACK_PORTS.max}, " \
                                 "where the agent waits on 127.0.0.1.")
      end
      taken = live_devices.map { |_key, row| row["userCode"] }
      user_code = Auth.new_user_code
      user_code = Auth.new_user_code while taken.include?(user_code)
      device_code = Auth.new_secret
      t = now_ms
      @store.put_row("devices", Auth.hash_secret(device_code), {
        "userCode" => user_code, "agentName" => agent_name.is_a?(String) ? Js.trim(agent_name) : nil,
        # what the agent asked for, and the issued credential's lifetime
        "scopes" => parsed["scopes"], "expiresInSeconds" => parsed["expiresInSeconds"],
        # when the codes stop working
        "createdAt" => iso_at(t), "expiresAt" => iso_at(t + CODE_TTL_SECONDS * 1000),
        "interval" => POLL_INTERVAL_SECONDS, "lastPolledAt" => nil,
        "status" => "pending", "approvedBy" => nil, "approvedScopes" => nil,
        # the 127.0.0.1 port the agent waits on, when it is on the person's
        # computer; the confirmation code's hash, once approved
        "loopbackPort" => port&.to_i, "confirmationHash" => nil, "confirmAttempts" => 0,
      })
      approve = "#{public_origin(headers)}#{ACCOUNT_URL}#approve"
      [200, {
        "a2app" => true, "deviceCode" => device_code, "userCode" => user_code,
        "verificationUri" => approve, "verificationUriComplete" => "#{approve}/#{user_code}",
        "expiresIn" => CODE_TTL_SECONDS, "interval" => POLL_INTERVAL_SECONDS,
      }]
    end

    def poll_device(body)
      device_code = body["deviceCode"]
      return err(400, "usage", "Poll with { deviceCode }.") unless device_code.is_a?(String)
      key = Auth.hash_secret(device_code)
      # Single use: reading the row and acting on it are one step.
      @auth_lock.synchronize do
        row = @store.row("devices", key)
        t = now_ms
        if row.nil? || ms_of(row["expiresAt"]) <= t
          @store.delete_row("devices", key) if row
          return err(400, "expired_token", "This sign-in request expired or was already used. Start again.")
        end
        if row["status"] == "denied"
          @store.delete_row("devices", key)
          return err(400, "access_denied", "The person declined this agent's request.")
        end
        if row["status"] == "approved" && row["approvedBy"] && row["approvedScopes"] && row["confirmationHash"]
          # Answered at once, whatever the interval: wrong guesses are bounded
          # by CONFIRM_ATTEMPTS instead.
          confirmation = body["confirmation"].is_a?(String) ? Auth.normalize_user_code(body["confirmation"]) : ""
          if confirmation.empty?
            return err(400, "confirmation_required", "Approved. Present the confirmation code the approval produced.",
                       "interval" => row["interval"])
          end
          unless OpenSSL.fixed_length_secure_compare(Auth.hash_secret(confirmation), row["confirmationHash"])
            attempts = row["confirmAttempts"] + 1
            if attempts >= CONFIRM_ATTEMPTS
              @store.delete_row("devices", key)
              return err(400, "access_denied", "Too many wrong confirmation codes: this request is void. Start again.")
            end
            @store.put_row("devices", key, row.merge("confirmAttempts" => attempts))
            return err(400, "confirmation_invalid",
                       "That is not this request's confirmation code (#{CONFIRM_ATTEMPTS - attempts} tries left).")
          end
          # The row goes before the credential is handed out.
          @store.delete_row("devices", key)
          info = principal_info(row["approvedBy"])
          return err(400, "access_denied", "The person who approved this is no longer active.") unless info && info["active"]
          token, grant = mint_credential(row["approvedBy"], row["agentName"], row["approvedScopes"], row["expiresInSeconds"])
          return [200, { "a2app" => true, "token" => token, "credential" => credential_wire(grant, info["name"]) }]
        end
        if row["lastPolledAt"] && t - row["lastPolledAt"] < row["interval"] * 1000
          interval = row["interval"] + SLOW_DOWN_STEP_SECONDS
          @store.put_row("devices", key, row.merge("interval" => interval, "lastPolledAt" => t))
          return err(400, "slow_down", "Polling too fast: wait #{interval} s between polls.", "interval" => interval)
        end
        @store.put_row("devices", key, row.merge("lastPolledAt" => t))
        err(400, "authorization_pending", "Waiting for the person to approve.", "interval" => row["interval"])
      end
    end

    # What the person is shown before deciding: who asked (as the requester
    # typed it), for what, when, and whether the agent waits on their own
    # computer.
    def review_device(headers, user_code)
      _manager, reply = manager_of(headers, false)
      return reply if reply
      found = device_by_user_code(user_code)
      unless found
        return err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.")
      end
      row = found[1]
      [200, { "a2app" => true, "userCode" => row["userCode"], "agentName" => row["agentName"], "scopes" => row["scopes"],
              "expiresIn" => row["expiresInSeconds"], "expiresAt" => row["expiresAt"],
              "requestedAt" => row["createdAt"], "loopback" => !row["loopbackPort"].nil? }]
    end

    def decide_device(headers, body, user_code)
      manager, reply = manager_of(headers, true)
      return reply if reply
      @auth_lock.synchronize do
        found = device_by_user_code(user_code)
        unless found
          return err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.")
        end
        key, row = found
        approve = body["approve"]
        return err(400, "usage", "Decide with { approve: true | false }.") unless [true, false].include?(approve)
        unless approve
          @store.put_row("devices", key, row.merge("status" => "denied"))
          return [200, { "a2app" => true, "ok" => true, "status" => "denied" }]
        end
        # The person may only narrow what was asked for.
        scopes = row["scopes"]
        if body.key?("scopes")
          parsed, problem = parse_grant_request({ "scopes" => body["scopes"] })
          return err(400, "usage", problem) if problem
          asked = row["scopes"].include?("*") ? nil : row["scopes"]
          wider = asked.nil? ? [] : parsed["scopes"].select { |s| s == "*" || !asked.include?(s) }
          unless wider.empty?
            return err(400, "usage", "Approval can only narrow what the agent asked for, not add #{wider.join(", ")}.")
          end
          scopes = parsed["scopes"]
        end
        confirmation = Auth.new_user_code
        @store.put_row("devices", key, row.merge("status" => "approved", "approvedBy" => manager["principal"],
                                                 "approvedScopes" => scopes,
                                                 "confirmationHash" => Auth.hash_secret(confirmation)))
        redirect = row["loopbackPort"] &&
                   "http://127.0.0.1:#{row["loopbackPort"]}#{LOOPBACK_CALLBACK}?confirmation=#{Js.encode_uri_component(confirmation)}"
        [200, { "a2app" => true, "ok" => true, "status" => "approved", "confirmation" => confirmation, "redirect" => redirect }]
      end
    end

    # Route one request under /api/_a2app/auth/, or nil.
    def handle_device(method, path, headers, body)
      body = body.is_a?(Hash) ? body : {}
      if path == "/api/_a2app/auth/device"
        return method == "POST" ? start_device(headers, body) : err(405, "usage", "Start a sign-in with POST.")
      end
      if path == "/api/_a2app/auth/token"
        return method == "POST" ? poll_device(body) : err(405, "usage", "Poll with POST.")
      end
      return nil unless path.start_with?("/api/_a2app/auth/device/")
      code = Js.decode_uri_component!(path["/api/_a2app/auth/device/".length..])
      return review_device(headers, code) if method == "GET"
      return decide_device(headers, body, code) if method == "POST"
      err(405, "usage", "#{method} not allowed on a sign-in request.")
    end

    # -- app -> agent -------------------------------------------------------

    # Emit a declared event and, with a capability, queue a task. `principal`
    # is who asked for the work; work the app queues on its own has none and
    # its agent acts as the owner. `dedup_key` names the occurrence when the
    # app knows better than (type, capability, payload, principal).
    def trigger(etype, payload, capability = nil, principal: nil, dedup_key: nil)
      @store.trigger(etype, payload, capability, principal: principal, dedup_key: dedup_key)
    end
  end

  # -------------------------------------------------------------- self-test
  # Parity oracle, run by the toolkit gate (`ruby lib/a2app_adapter.rb
  # --selftest`). Its job is to prove this port, `@a2app/rules` and
  # `@a2app/adapter-core` agree, so a Rails app and a Node app reject
  # identical payloads identically, block identical operations for identical
  # stated reasons, and keep the same promises across a restart. The expected
  # values are what the reference computes — do not "improve" one here
  # without moving the reference first.
  def self.selftest
    require "tmpdir"
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

    # Host and network policy: the app answers only to loopback and its own
    # origins (the public URL among them), and refuses to listen where the
    # agent token would cross a network in clear.
    hosted = Adapter.new(app_id: "selftest", app_name: nil, entities: {}, operations: [], store: Store.new, token: "t",
                         modules: [{ "name" => "core" }], allowed_origins: ["http://127.0.0.1:9931"],
                         public_url: "https://crm.example.com")
    check.call("the public host is answered", hosted.allowed_host?("crm.example.com"), true)
    check.call("…with an explicit port", hosted.allowed_host?("crm.example.com:443"), true)
    check.call("loopback is answered", hosted.allowed_host?("127.0.0.2:9931"), true)
    check.call("an IPv6 loopback literal is answered", hosted.allowed_host?("[::1]:9931"), true)
    check.call("a rebound host is refused", hosted.allowed_host?("evil.example.com"), false)
    check.call("a lookalike host is refused", hosted.allowed_host?("localhost.evil.example.com"), false)
    check.call("dispatch refuses a foreign host before identity",
               hosted.dispatch("GET", "/api/_a2app", { "Host" => "evil.example.com" }, nil)[0], 403)
    policy = lambda do |host, public_url|
      Network.policy(host, public_url)
    rescue ArgumentError
      "refused"
    end
    check.call("loopback by default", policy.call(nil, nil), ["127.0.0.1", nil])
    check.call("an https public URL is reduced to its origin", policy.call(nil, "https://CRM.example.com/x"),
               ["127.0.0.1", "https://crm.example.com"])
    check.call("a non-loopback bind needs a public URL", policy.call("0.0.0.0", nil), "refused")
    check.call("…an https one", policy.call("0.0.0.0", "http://localhost:8080"), "refused")
    check.call("a non-loopback bind behind https is allowed", policy.call("0.0.0.0", "https://crm.example.com"),
               ["0.0.0.0", "https://crm.example.com"])
    check.call("a plain-http public name is refused", policy.call(nil, "http://crm.example.com"), "refused")
    check.call("a plain-http tunnel to loopback is allowed", policy.call(nil, "http://localhost:9000"),
               ["127.0.0.1", "http://localhost:9000"])
    check.call("a public URL that is not a URL is refused", policy.call(nil, "crm.example.com"), "refused")

    # 7. Auth primitives (spec/v0_2/auth.md): the expected values are what
    #    adapter-core's auth.ts produces, so a password set on one stack
    #    signs in on every other, and a code or cookie reads the same.
    check.call("a stored secret is its hex SHA-256", Auth.hash_secret("abc"),
               "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    check.call("a token is a2a_ + 256 bits, base64url", Auth.new_token.match?(/\Aa2a_[A-Za-z0-9_-]{43}\z/), true)
    # Produced by adapter-core's hashPassword("correct horse battery", 1000).
    vector = "pbkdf2_sha256$1000$2sUk4tIcL7NboFK4NwYlkg==$nUNx8GkVexI8Drhlp/ZJQdZ8zjj6t3TymkkMvr+kIF8="
    check.call("adapter-core's password hash verifies", Auth.verify_password("correct horse battery", vector), true)
    check.call("…and refuses a wrong password", Auth.verify_password("correct horse batterY", vector), false)
    stored = Auth.hash_password("a long enough password")
    parts = stored.split("$")
    check.call("a password is stored as pbkdf2_sha256 at 600 000 iterations",
               [parts[0], parts[1], parts[2].unpack1("m").bytesize, parts[3].unpack1("m").bytesize],
               ["pbkdf2_sha256", "600000", 16, 32])
    check.call("…and verifies", Auth.verify_password("a long enough password", stored), true)
    check.call("a malformed hash never matches", Auth.verify_password("x", "pbkdf2_sha256$0$AA==$AA=="), false)
    check.call("…nor another scheme", Auth.verify_password("x", "md5$1$AA==$AA=="), false)
    check.call("a user code is XXXX-XXXX from the consonant alphabet",
               Auth.new_user_code.match?(/\A[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\z/), true)
    check.call("a typed code ignores case and the dash",
               [Auth.normalize_user_code("bcdf-ghjk"), Auth.normalize_user_code(" b c d f g h j k ")],
               ["BCDF-GHJK", "BCDF-GHJK"])
    check.call("…and is empty when it is not 8 letters of the alphabet",
               [Auth.normalize_user_code("bcdfghj"), Auth.normalize_user_code("AEIOUBCDFGHJK")], ["", "BCDF-GHJK"])
    check.call("cookies: the first of a name wins, values are decoded",
               Auth.parse_cookies("a=1; b=x%20y; a=2; =bad; c"), { "a" => "1", "b" => "x y", "" => "bad" })
    check.call("…and a value this app did not write is dropped", Auth.parse_cookies("x=%E0%A4%A"), {})
    check.call("the session cookie's attributes",
               Auth.session_cookie("a2app_session_x", "v", max_age_seconds: 1_209_600, secure: true),
               "a2app_session_x=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure")
    check.call("a login is trimmed and lower-cased", Auth.normalize_login("  Bob@Example.COM "), "bob@example.com")
    clock = 0
    limiter = Auth::FailureLimiter.new(10, 900_000, -> { clock })
    10.times { limiter.fail("bob") }
    check.call("ten failures lock a login for the window", limiter.retry_after("bob"), 900)
    clock = 900_000
    check.call("…and the window ending frees it", limiter.retry_after("bob"), 0)

    # 8. The ceiling, the refusals in spec §9's order, and ownership, through
    #    dispatch on a multi-user app with two accounts.
    owned_defs = { "tasks" => { "module" => "core", "ownedBy" => "owner", "fields" => [
      { "name" => "title", "type" => "string" }, { "name" => "owner", "type" => "string", "readOnly" => true },
    ] } }
    multi = Adapter.new(app_id: "selftest", app_name: nil, entities: owned_defs, operations: [], store: Store.new,
                        token: "admin-token", modules: [{ "name" => "core" }], auth_mode: "multi-user",
                        allowed_origins: ["http://127.0.0.1:9931"],
                        permissions_of: ->(p) { p["role"] == "owner" ? ["*"] : ["data:tasks:read"] })
    mstore = multi.store
    { "usr_o" => "owner", "usr_m" => "member" }.each do |id, role|
      mstore.put_row("users", id, { "id" => id, "name" => role.capitalize, "login" => role, "role" => role,
                                    "active" => true, "createdAt" => Rules.now_iso, "passwordHash" => "" })
    end
    mstore.put_record("tasks", { "id" => "t_o", "title" => "the owner's", "owner" => "usr_o" })
    mstore.put_record("tasks", { "id" => "t_m", "title" => "the member's", "owner" => "usr_m" })
    call = lambda do |method, path, headers = {}, body = nil|
      multi.dispatch(method, path, { "host" => "127.0.0.1:9931" }.merge(headers), body)
    end
    admin = { "x-a2app-token" => "admin-token" }
    issued = call.call("POST", "/api/_a2app/credentials", admin, { "principal" => "usr_m", "agentName" => "selftest" })
    member = { "x-a2app-token" => issued[1]["token"] }
    check.call("the admin credential issues for anyone, expiring", [issued[0], issued[1]["credential"]["principal"],
                                                                   issued[1]["credential"]["expiresAt"].nil?],
               [201, "usr_m", false])
    check.call("only the token's hash is stored",
               mstore.grant_by_token_hash(Auth.hash_secret(issued[1]["token"]))&.key?("token"), false)
    who = call.call("GET", "/api/_a2app/whoami", member)[1]
    check.call("a `*` credential is held to its person's permissions",
               [who["principal"], who["principalName"], who["role"], who["scopes"]],
               ["usr_m", "Member", "member", ["data:tasks:read"]])
    check.call("…on every request", call.call("POST", "/api/collections/tasks/records", member, { "title" => "x" })[1]["code"],
               "insufficient_scope")
    check.call("a member lists only its own records",
               call.call("GET", "/api/collections/tasks/records", member)[1]["items"].map { |r| r["id"] }, ["t_m"])
    check.call("…and another's answers 404", call.call("GET", "/api/collections/tasks/records/t_o", member)[0], 404)
    check.call("the owner sees every record",
               call.call("GET", "/api/collections/tasks/records", admin)[1]["items"].map { |r| r["id"] }.sort, ["t_m", "t_o"])
    created = call.call("POST", "/api/collections/tasks/records", admin, { "title" => "new" })[1]
    check.call("create fills the owner field with the caller", created["owner"], "owner")
    check.call("…which no client may write",
               call.call("POST", "/api/collections/tasks/records", admin, { "title" => "y", "owner" => "usr_m" })[1]["code"],
               "read_only_field")
    check.call("an unknown token", call.call("GET", "/api/_a2app/whoami", { "x-a2app-token" => "a2a_nope" })[1]["code"],
               "credential_invalid")
    mstore.put_row("users", "usr_m", mstore.row("users", "usr_m").merge("active" => false))
    check.call("a deactivated person's credential", call.call("GET", "/api/_a2app/whoami", member)[1]["code"],
               "principal_inactive")
    mstore.put_row("users", "usr_m", mstore.row("users", "usr_m").merge("active" => true))
    grant = mstore.grant_by_id(issued[1]["credential"]["credentialId"])
    mstore.put_grant(grant.merge("expiresAt" => "2020-01-01T00:00:00.000Z"))
    check.call("an expired credential", call.call("GET", "/api/_a2app/whoami", member)[1]["code"], "token_expired")
    mstore.put_grant(grant.merge("revokedAt" => Rules.now_iso, "expiresAt" => "2020-01-01T00:00:00.000Z"))
    check.call("a revoked one says so before expired", call.call("GET", "/api/_a2app/whoami", member)[1]["code"],
               "credential_revoked")
    check.call("a stranger needs a credential", call.call("GET", "/api/collections/tasks/records")[1]["code"],
               "agent_token_required")
    check.call("…or, from the app's own page, to sign in",
               call.call("GET", "/api/collections/tasks/records", { "sec-fetch-site" => "same-origin" })[1]["code"],
               "sign_in_required")
    other = call.call("POST", "/api/_a2app/credentials", admin, { "principal" => "usr_o" })[1]["token"]
    check.call("an agent's credential manages nothing, even an owner's",
               call.call("GET", "/api/_a2app/credentials", { "x-a2app-token" => other })[1]["code"], "not_a_manager")
    check.call("the admin credential cannot be revoked through the API",
               call.call("DELETE", "/api/_a2app/credentials/cred_local", admin)[1]["code"], "not_a_manager")
    check.call("a scope the app does not declare is not granted",
               call.call("POST", "/api/_a2app/credentials", admin, { "scopes" => ["data:nope:read"] })[0], 400)
    check.call("the same request from two people is two tasks", [
      mstore.trigger("t.x", { "a" => 1 }, "cap", principal: "usr_m")["taskId"] ==
        mstore.trigger("t.x", { "a" => 1 }, "cap", principal: "usr_m")["taskId"],
      mstore.trigger("t.x", { "a" => 1 }, "cap", principal: "usr_m")["taskId"] ==
        mstore.trigger("t.x", { "a" => 1 }, "cap", principal: "usr_o")["taskId"],
    ], [true, false])

    # Who reaches a task (spec §6.3): an owner every task, a task credential
    # its own, anyone else the tasks they asked for; progress and completion
    # only from the run that holds it. And asking again (§6.1).
    asks = ->(principal) { mstore.trigger("t.ask", { "n" => 1 }, "cap", principal: principal)["taskId"] }
    mine = asks.call("usr_m")
    theirs = asks.call("usr_o")
    as_member = { "x-a2app-token" => call.call("POST", "/api/_a2app/credentials", admin, { "principal" => "usr_m" })[1]["token"] }
    listed = ->(headers) { call.call("GET", "/api/_a2app/tasks", headers)[1]["tasks"].map { |t| t["id"] } & [mine, theirs] }
    code_of = ->(method, path, headers, body = nil) { call.call(method, path, headers, body)[1]["code"] }
    check.call("an owner lists every task, a member only the ones they asked for",
               [listed.call(admin), listed.call(as_member)], [[mine, theirs], [mine]])
    check.call("…another's task answers as one that does not exist, on every route",
               [code_of.call("GET", "/api/_a2app/tasks/#{theirs}", as_member)] +
                 %w[claim progress complete cancel credential].map { |action|
                   code_of.call("POST", "/api/_a2app/tasks/#{theirs}/#{action}", as_member, {})
                 },
               ["task_not_found"] * 6)
    call.call("POST", "/api/_a2app/tasks/#{mine}/claim", admin, {})
    run = { "x-a2app-token" => call.call("POST", "/api/_a2app/tasks/#{mine}/credential", admin, {})[1]["token"] }
    check.call("a task credential reaches its own task, and no other",
               [call.call("GET", "/api/_a2app/tasks/#{mine}", run)[0], listed.call(run),
                code_of.call("GET", "/api/_a2app/tasks/#{theirs}", run)],
               [200, [mine], "task_not_found"])
    check.call("…and reports on it, whoever claimed it",
               call.call("POST", "/api/_a2app/tasks/#{mine}/progress", run, { "step" => "reading" })[0], 200)
    check.call("the person who asked cannot report on a run they do not hold",
               [code_of.call("POST", "/api/_a2app/tasks/#{mine}/progress", as_member, { "step" => "x" }),
                code_of.call("POST", "/api/_a2app/tasks/#{mine}/complete", as_member, { "status" => "completed" })],
               %w[task_not_held task_not_held])
    check.call("…which is audited", mstore.audit_tail(1)[0].values_at("target", "outcome", "code"),
               ["task:complete", "rejected", "task_not_held"])
    check.call("…but can cancel it, and a canceled task says so first",
               [call.call("POST", "/api/_a2app/tasks/#{mine}/cancel", as_member, {})[0],
                code_of.call("POST", "/api/_a2app/tasks/#{mine}/complete", as_member, { "status" => "completed" })],
               [200, "task_canceled"])
    again = asks.call("usr_m")
    check.call("once a task is finished, the same request queues a new one, which a repeat then joins",
               [again != mine, asks.call("usr_m") == again], [true, true])
    call.call("POST", "/api/_a2app/tasks/#{again}/claim", as_member, {})
    check.call("a member who claims their own task holds it, and reports on it",
               call.call("POST", "/api/_a2app/tasks/#{again}/complete", as_member,
                         { "status" => "completed", "result" => {} })[0], 200)

    # 9. A single-user app: the View reads as the owner, accounts do not exist,
    #    and the model is refused when ownership or capabilities are miswired.
    single = Adapter.new(app_id: "selftest", app_name: nil, entities: owned_defs, operations: [], store: Store.new,
                         token: "admin-token", modules: [{ "name" => "core" }], allowed_origins: ["http://127.0.0.1:9931"])
    view_read = single.dispatch("GET", "/api/_a2app/whoami", { "sec-fetch-site" => "same-origin" }, nil)[1]
    check.call("the single-user View reads as the owner", [view_read["credentialId"], view_read["principal"]], ["ui", "owner"])
    check.call("…a foreign page does not",
               single.dispatch("GET", "/api/_a2app/whoami", { "origin" => "https://evil.example" }, nil)[1]["code"],
               "forbidden_origin")
    check.call("accounts exist only on a multi-user app",
               single.dispatch("GET", "/api/_a2app/session", {}, nil)[1]["code"], "not_multi_user")
    miswired = lambda do |defs, capabilities = nil|
      Adapter.new(app_id: "selftest", app_name: nil, entities: defs, operations: [], store: Store.new, token: "t",
                  modules: [{ "name" => "core" }], capabilities: capabilities)
      "served"
    rescue ArgumentError
      "refused"
    end
    check.call("ownedBy must name a field", miswired.call({ "tasks" => owned_defs["tasks"].merge("ownedBy" => "nope") }),
               "refused")
    check.call("…a readOnly string one", miswired.call({ "tasks" => { "module" => "core", "ownedBy" => "owner",
                                                                   "fields" => [{ "name" => "owner", "type" => "string" }] } }),
               "refused")
    check.call("a capability may only need declared scopes",
               miswired.call(owned_defs, { "triage" => { "scopes" => ["data:nope:read"] } }), "refused")

    # 10. JavaScript's reading of values: Number(), how a number prints, RFC
    #     8785, query strings and paging, read as adapter-core reads them. The
    #     expected values are what Node computes.
    check.call("Number() of a string",
               ["010", "0x1A", "1e3", " 5 ", "1_0", "inf", "Infinity", "", "1.", ".5", "-0x10", "0b101"]
                 .map { |s| Js.number_to_s(Js.number(s)) },
               %w[10 26 1000 5 NaN NaN Infinity 0 1 0.5 NaN 5])
    number = { "type" => "number" }
    check.call("a number string is stored as the number it reads as",
               %w[1e3 5.0 0x1A 1.5].map { |s| Rules.coerce(number, s) }, [1000, 5, 26, 1.5])
    canonical = Js.canonicalize({
      "b" => [1, 2.5, "x\n\u0001", 1e21, 1e-7, 0.000001, -0.0, 123_456_789_012_345_680_000.0],
      "a" => nil, "\u00e9" => true, "\uffff" => 1, "\u{1F600}" => 2,
    })
    check.call("RFC 8785, as adapter-core canonicalizes",
               canonical,
               '{"a":null,"b":[1,2.5,"x\n\u0001",1e+21,1e-7,0.000001,0,123456789012345680000],"' \
               "\u00e9\":true,\"\u{1F600}\":2,\"\uffff\":1}")
    check.call("the approval key is adapter-core's",
               [Rules.approval_key("clear-done", {}), Rules.approval_key("complete-task", { "task" => "rec_1", "n" => 5 })],
               %w[7d745c845ebc004f343ea667d5b6e711ae3a8b842858cb0e79e4d3026519c00c
                  8c6e95264d0d7c85583a20d1a8ad354a7d7ea475ce9c27815343669dc5a0d06d])
    check.call("a query string as URLSearchParams reads it",
               Js.parse_query("a=1&a=2&sort[]=x&f=50%&g=a+b&h=%E2%9C%93"),
               { "a" => "2", "sort[]" => "x", "f" => "50%", "g" => "a b", "h" => "\u2713" })
    paged = Store.new
    [%w[t0 b], %w[t1 a], %w[t2 c], ["t3", nil], %w[t4 a]].each do |id, title|
      paged.put_record("tasks", title ? { "id" => id, "title" => title } : { "id" => id })
    end
    ids = ->(query) { paged.list_records("tasks", query)["items"].map { |r| r["id"] } }
    check.call("page 0, perPage 0 and perPage NaN select nothing",
               [ids.call({ "page" => 0.0, "perPage" => 2.0 }), ids.call({ "perPage" => 0.0 }),
                ids.call({ "perPage" => Float::NAN })], [[], [], []])
    check.call("…and a fractional perPage is truncated", ids.call({ "perPage" => 1.5 }), ["t0"])
    check.call("a sort puts blanks first, and keeps ties in order",
               [ids.call({ "sort" => "title" }), ids.call({ "sort" => "-title" })],
               [%w[t3 t1 t4 t0 t2], %w[t2 t0 t1 t4 t3]])

    # 11. The record guard's current rules (adapters/rules/src/index.ts).
    guard_fields = [
      { "name" => "title", "type" => "string", "required" => true, "max" => 5 },
      { "name" => "tags", "type" => "list<enum>", "values" => %w[a b] },
      { "name" => "size", "type" => "enum", "values" => [1, 2] },
      { "name" => "count", "type" => "number" },
      { "name" => "secret", "type" => "string", "writeOnly" => true },
    ]
    found = lambda do |body, require_required: false|
      Rules.validate(guard_fields, body, require_required: require_required).map { |v| [v["field"], v["code"], v["expected"]] }
    end
    required = ["title", "missing_required", "a non-blank value (required field)"]
    check.call("a required field left out of a create is missing_required", found.call({}, require_required: true), [required])
    check.call("…as is one blanked on any write", found.call({ "title" => "" }), [required])
    check.call("…but an update may leave it out", found.call({}), [])
    check.call("text past its max, counted as JavaScript counts",
               [found.call({ "title" => "toolong" }), found.call({ "title" => "\u{1F600}\u{1F600}\u{1F600}" })],
               [[["title", "invalid_string", "text of at most 5 characters"]]] * 2)
    check.call("a list<enum> takes an array, never a scalar", found.call({ "tags" => "a" }),
               [["tags", "invalid_enum", "an array of: a | b"]])
    check.call("enum values compare as strings", found.call({ "size" => "1" }), [])
    check.call("a boolean is not a number", found.call({ "count" => true }), [["count", "invalid_number", "a number"]])
    check.call("nothing is writable: the undeclared field says so",
               Rules.validate([], { "x" => 1 }).map { |v| v["expected"] }, ["nothing — no writable fields are declared"])
    check.call("a write-only field is never read back", Rules.divergences(guard_fields, { "secret" => "s" }, ->(_n) {}), [])
    check.call("numeric enum values fingerprint",
               Rules.schema_fingerprint({ "x" => { "fields" => guard_fields, "module" => "m" } }).start_with?("sv_"), true)
    check.call("a negated condition explains itself",
               [Rules.explain_predicate({ "not" => { "any" => [{ "field" => "status", "eq" => "doing" }] } }, record, fields),
                Rules.explain_predicate({ "not" => { "field" => "status", "in" => ["doing"] } }, record, fields)],
               ["the condition on the record is not met", "the condition on status is not met"])

    # 12. Operations, records, tasks and events through dispatch: arguments
    #     guarded, idempotency, approval, typed refusals, the task lifecycle,
    #     dataVersion, viewers and the audit log.
    ops = [
      { "name" => "wipe", "destructive" => true, "module" => "core", "params" => {} },
      { "name" => "rename", "module" => "core", "entity" => "tasks",
        "params" => { "task" => { "type" => "ref", "entity" => "tasks", "required" => true }, "to" => { "type" => "string" } } },
      { "name" => "refuse", "module" => "core", "params" => {} },
      { "name" => "explode", "module" => "core", "params" => {} },
      { "name" => "queue", "module" => "core", "params" => {} },
    ]
    runners = {
      "wipe" => ->(_args, _ctx, _store) { { "wiped" => true } },
      "rename" => ->(args, _ctx, _store) { { "renamed" => args["task"] } },
      "refuse" => ->(_args, _ctx, _store) { raise OperationError.new("not_today", "Not today.", 409, { "retry" => "tomorrow" }) },
      "explode" => ->(_args, _ctx, _store) { raise "boom" },
      "queue" => ->(_args, _ctx, store) { store.trigger("t.x", { "n" => 1 }, "cap") },
    }
    boot = lambda do |store, **options|
      Adapter.new(app_id: "selftest", app_name: nil, entities: owned_defs, operations: ops, store: store,
                  token: "admin-token", modules: [{ "name" => "core" }], allowed_origins: ["http://127.0.0.1:9931"],
                  operation_runners: runners, **options)
    end
    as_admin = lambda do |app, method, path, body = nil, headers = {}|
      app.dispatch(method, path, { "host" => "127.0.0.1:9931", "x-a2app-token" => "admin-token" }.merge(headers), body)
    end
    app = boot.call(Store.new, app_version: "")
    run = ->(*args) { as_admin.call(app, *args) }
    outcome = ->(reply) { [reply[0], reply[1]["code"]] }
    check.call("an operation's required parameter is enforced", outcome.call(run.call("POST", "/api/ops/rename", {})),
               [400, "missing_required"])
    check.call("…and an undeclared one refused", outcome.call(run.call("POST", "/api/ops/rename", { "task" => "t", "x" => 1 })),
               [400, "unknown_field"])
    asked = run.call("POST", "/api/ops/wipe", {})
    check.call("a destructive call asks for approval with the reference's key",
               [asked[0], asked[1]["approvalKey"]], [428, Rules.approval_key("wipe", {})])
    approved = { "x-a2app-approval" => asked[1]["approvalKey"] }
    check.call("…which runs it once", [run.call("POST", "/api/ops/wipe", {}, approved)[0],
                                       run.call("POST", "/api/ops/wipe", {}, approved)[0]], [200, 428])
    keyed = { "idempotency-key" => "op-1" }
    check.call("a repeated operation is duplicate_request",
               [run.call("POST", "/api/ops/rename", { "task" => "t" }, keyed)[0],
                outcome.call(run.call("POST", "/api/ops/rename", { "task" => "t" }, keyed))], [200, [409, "duplicate_request"]])
    refused = run.call("POST", "/api/ops/refuse", {})
    check.call("a runner refuses with its own status, code and fields",
               [refused[0], refused[1]["code"], refused[1]["retry"]], [409, "not_today", "tomorrow"])
    check.call("…and anything else it throws is operation_failed",
               outcome.call(run.call("POST", "/api/ops/explode", {})), [500, "operation_failed"])
    check.call("an escaped operation name is decoded", run.call("POST", "/api/ops/re%6Eame", { "task" => "t" })[0], 200)
    before = app.identity
    created = run.call("POST", "/api/collections/tasks/records", { "title" => "kept" })[1]
    after_write = app.identity["dataVersion"]
    run.call("POST", "/api/collections/tasks/records", { "nope" => 1 })
    check.call("dataVersion moves on a write, not on a refused one",
               [before["dataVersion"] != after_write, app.identity["dataVersion"] == after_write], [true, true])
    check.call("identity omits an empty appVersion and names its timezone",
               [before.key?("appVersion"), before["serverTzOffsetMinutes"].is_a?(Integer)], [false, true])
    keyed_update = { "idempotency-key" => "patch-1" }
    record_path = "/api/collections/tasks/records/#{created["id"]}"
    check.call("a repeated update is duplicate_request",
               [run.call("PATCH", record_path, { "title" => "again" }, keyed_update)[0],
                outcome.call(run.call("PATCH", record_path, { "title" => "again" }, keyed_update))], [200, [409, "duplicate_request"]])
    bad_filter = run.call("GET", "/api/collections/tasks/records?filter=title%20~~%20x")[1]
    check.call("a filter it cannot honour is refused, naming it", [bad_filter["code"], bad_filter["got"]],
               ["invalid_filter", "title ~~ x"])
    check.call("an escaped record id is decoded", outcome.call(run.call("GET", "/api/collections/tasks/records/no%20such")),
               [404, "record_not_found"])
    check.call("a miss in the adapter's namespaces is its own; elsewhere it is the View's",
               [outcome.call(run.call("GET", "/api/_a2app/nope")), run.call("GET", "/api/elsewhere")], [[404, "not_found"], nil])
    described = run.call("GET", "/api/_a2app/describe/core/tasks/#{created["id"]}")[1]
    check.call("a record's operation names the parameter that takes it",
               described["operations"].find { |o| o["name"] == "rename" }["targetParam"], "task")
    app.dispatch("GET", "/api/_a2app", { "host" => "127.0.0.1:9931", "x-a2app-viewer" => "tab-1" }, nil)
    open_tabs = -> { run.call("GET", "/api/_a2app/viewers")[1]["viewers"] }
    counted = open_tabs.call
    app.dispatch("GET", "/api/_a2app?viewer=tab-1&leaving=1", { "host" => "127.0.0.1:9931" }, nil)
    check.call("a tab's heartbeat is counted until it says goodbye", [counted, open_tabs.call], [1, 0])
    queued = run.call("POST", "/api/ops/queue", {})[1]["result"]["taskId"]
    task = run.call("GET", "/api/_a2app/tasks/#{queued}")[1]
    check.call("a task has a random id, names its app, and starts with no progress",
               [queued.match?(/\Atsk_\h{16}\z/), task["app"], task["progress"]], [true, "selftest", { "step" => nil, "percent" => 0 }])
    check.call("claiming as someone else is principal_mismatch",
               outcome.call(run.call("POST", "/api/_a2app/tasks/#{queued}/claim", { "agent" => "someone-else" })),
               [403, "principal_mismatch"])
    run.call("POST", "/api/_a2app/tasks/#{queued}/claim", {})
    run.call("POST", "/api/_a2app/tasks/#{queued}/complete", { "status" => "completed", "result" => false })
    check.call("a falsy result is kept, and a finished task cannot be canceled",
               [run.call("GET", "/api/_a2app/tasks/#{queued}")[1]["result"],
                outcome.call(run.call("POST", "/api/_a2app/tasks/#{queued}/cancel", {}))], [false, [409, "task_not_claimable"]])
    events = run.call("GET", "/api/_a2app/events")[1]
    check.call("events name their app, and a cursor that is not one reads from the beginning",
               [events["events"].map { |e| [e["id"].match?(/\Aevt_\h{16}\z/), e["app"]] }.uniq,
                run.call("GET", "/api/_a2app/events?since=abc")[1]["nextCursor"] == events["nextCursor"]],
               [[[true, "selftest"]], true])
    audited = app.store.audit_tail(100).map { |e| [e["target"], e["outcome"]] }
    check.call("writes, operations and task actions are audited",
               [["data:tasks", "ok"], ["op:wipe", "ok"], ["op:explode", "rejected"], ["task:claim", "rejected"],
                ["task:complete", "ok"]].all? { |entry| audited.include?(entry) }, true)
    limited = boot.call(Store.new, rate_limits: { "data" => 1 })
    as_admin.call(limited, "GET", "/api/collections/tasks/records")
    over = as_admin.call(limited, "GET", "/api/collections/tasks/records")
    rate_entry = limited.store.audit_tail(1)[0]
    check.call("over the rate limit: 429, retry after the window, audited by the token's hash",
               [over[0], over[1]["retryAfterSeconds"], rate_entry["target"], rate_entry["credentialId"]],
               [429, 60, "rate:data", "token:#{Auth.hash_secret("admin-token")}"])

    # 13. Device sign-in hands over nothing on approval alone: the credential
    #     goes to the poll that presents the confirmation code.
    device = lambda do |body|
      call.call("POST", "/api/_a2app/auth/device", {}, body)[1]
    end
    decide = lambda do |started|
      call.call("POST", "/api/_a2app/auth/device/#{started["userCode"]}", admin, { "approve" => true })[1]
    end
    poll = lambda do |started, confirmation = nil|
      body = { "deviceCode" => started["deviceCode"] }
      body["confirmation"] = confirmation unless confirmation.nil?
      call.call("POST", "/api/_a2app/auth/token", {}, body)[1]
    end
    started = device.call({ "agentName" => "cli" })
    review = call.call("GET", "/api/_a2app/auth/device/#{started["userCode"]}", admin)[1]
    check.call("the review says when it was asked, and that no agent waits on this computer",
               [review["requestedAt"].is_a?(String), review["loopback"]], [true, false])
    decision = decide.call(started)
    check.call("approval issues a one-time confirmation code, with nowhere to send it",
               [decision["confirmation"].match?(/\A[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\z/), decision["redirect"]],
               [true, nil])
    check.call("approval alone hands nothing over, nor does a wrong code",
               [poll.call(started)["code"], poll.call(started, "BBBB-BBBB")["code"]], %w[confirmation_required confirmation_invalid])
    check.call("the code (any case, no dash) gets the credential, once",
               [poll.call(started, decision["confirmation"].downcase.delete("-"))["credential"]["principal"],
                poll.call(started, decision["confirmation"])["code"]], %w[owner expired_token])
    guessed = device.call({})
    decide.call(guessed)
    4.times { poll.call(guessed, "BBBB-BBBB") }
    check.call("five wrong codes void the request", poll.call(guessed, "BBBB-BBBB")["code"], "access_denied")
    check.call("a loopback port must be a real one",
               [call.call("POST", "/api/_a2app/auth/device", {}, { "loopbackPort" => 80 })[1]["code"],
                call.call("POST", "/api/_a2app/auth/device", {}, { "loopbackPort" => 53_682.5 })[1]["code"]], %w[usage usage])
    local = device.call({ "loopbackPort" => 53_682 })
    local_review = call.call("GET", "/api/_a2app/auth/device/#{local["userCode"]}", admin)[1]
    sent = decide.call(local)
    check.call("an agent on this computer is shown as such, and the browser sent back to it with the code",
               [local_review["loopback"], sent["redirect"]],
               [true, "http://127.0.0.1:53682/a2app/callback?confirmation=#{sent["confirmation"]}"])

    # 14. A restart forgets nothing the protocol promised: tasks and their
    #     credentials, the event cursor, approval and idempotency keys (until
    #     they expire), queued occurrences and the audit log all persist; the
    #     event and audit logs are rings whose numbering never restarts.
    begin
      Dir.mktmpdir("a2app-selftest-") do |tmp|
        db_path = File.join(tmp, "db.sqlite")
        clock = Rules.now_ms
        reopen = -> { SqliteStore.new(db_path, clock: -> { clock }) }
        first_store = reopen.call
        first = boot.call(first_store)
        queued = as_admin.call(first, "POST", "/api/ops/queue", {})[1]["result"]["taskId"]
        task_token = as_admin.call(first, "POST", "/api/_a2app/tasks/#{queued}/credential", {})[1]["token"]
        cursor = as_admin.call(first, "GET", "/api/_a2app/events")[1]["nextCursor"]
        key = as_admin.call(first, "POST", "/api/ops/wipe", {})[1]["approvalKey"]
        as_admin.call(first, "POST", "/api/collections/tasks/records", { "title" => "kept" }, { "idempotency-key" => "k" })
        first_store.close

        second_store = reopen.call
        second = boot.call(second_store)
        check.call("a task and its credential survive a restart",
                   [as_admin.call(second, "GET", "/api/_a2app/tasks/#{queued}")[1]["status"],
                    second.dispatch("GET", "/api/_a2app/whoami", { "host" => "127.0.0.1:9931", "x-a2app-token" => task_token }, nil)[0]],
                   ["submitted", 200])
        check.call("…the same occurrence is still that task, and a new one gets a fresh id",
                   [second.trigger("t.x", { "n" => 1 }, "cap", principal: "owner")["taskId"] == queued,
                    second.trigger("t.x", { "n" => 2 }, "cap")["taskId"].then { |id| id != queued && id.start_with?("tsk_") }],
                   [true, true])
        check.call("…a saved event cursor reads only what came after",
                   as_admin.call(second, "GET", "/api/_a2app/events?since=#{cursor}")[1]["events"].map { |e| e["payload"] },
                   [{ "n" => 1 }, { "n" => 2 }])
        as_admin.call(second, "POST", "/api/_a2app/tasks/#{queued}/cancel", {})
        again = second.trigger("t.x", { "n" => 1 }, "cap", principal: "owner")["taskId"]
        check.call("…once that task is finished, the same occurrence is a new task, which a repeat then joins",
                   [again != queued, second.trigger("t.x", { "n" => 1 }, "cap", principal: "owner")["taskId"] == again],
                   [true, true])
        check.call("…an approval key still runs its call, and an idempotency key still holds",
                   [as_admin.call(second, "POST", "/api/ops/wipe", {}, { "x-a2app-approval" => key })[0],
                    as_admin.call(second, "POST", "/api/collections/tasks/records", { "title" => "kept" }, { "idempotency-key" => "k" })[0]],
                   [200, 409])
        check.call("…and the audit log is still there", second_store.audit_tail(100).any? { |e| e["target"] == "op:wipe" }, true)
        late = as_admin.call(second, "POST", "/api/ops/wipe", {})[1]["approvalKey"]
        clock += Store::APPROVAL_TTL_MS + 1
        check.call("an approval key expires after 10 minutes",
                   as_admin.call(second, "POST", "/api/ops/wipe", {}, { "x-a2app-approval" => late })[0], 428)
        clock += Store::IDEMPOTENCY_TTL_MS
        check.call("an idempotency key after 24 hours",
                   as_admin.call(second, "POST", "/api/collections/tasks/records", { "title" => "kept" }, { "idempotency-key" => "k" })[0],
                   200)
        second_store.close

        ring_path = File.join(tmp, "ring.sqlite")
        ring = SqliteStore.new(ring_path, event_retention: 3, audit_retention: 2)
        5.times { |i| ring.append_event("t.x", { "i" => i }) }
        3.times { |i| ring.append_audit({ "target" => "t#{i}" }) }
        kept = [ring.events_since(nil)["events"].map { |e| e["seq"] }, ring.audit_tail(10).map { |e| e["target"] }]
        ring.close
        ring = SqliteStore.new(ring_path, event_retention: 3)
        check.call("the event and audit logs are rings, and a seq is never reused",
                   [kept, ring.append_event("t.x", {})["seq"]], [[[3, 4, 5], %w[t1 t2]], 6])
        ring.close
      end
    rescue StandardError => e
      failures << "persistence: #{e.class}: #{e.message}"
    end

    # 15. The View is served with validators, behind one honest 404.
    Dir.mktmpdir("a2app-selftest-") do |tmp|
      public_dir = File.join(tmp, "public")
      FileUtils.mkdir_p(File.join(public_dir, "assets"))
      File.write(File.join(public_dir, "index.html"), "<p>hi</p>")
      File.write(File.join(tmp, "watcher.js"), "// watcher")
      view = StaticView.new(public_dir, aliases: { "/_a2app/update.js" => File.join(tmp, "watcher.js") }, version_ttl_ms: 0)
      index = view.serve("GET", "/", {})
      check.call("the index is served with an ETag, revalidated every time",
                 [index[0], index[1]["etag"].match?(/\A"\h{32}"\z/), index[1]["cache-control"], index[2]],
                 [200, true, "no-cache", "<p>hi</p>"])
      check.call("an unchanged file is a 304, compared weakly",
                 [view.serve("GET", "/index.html", { "if-none-match" => "W/#{index[1]["etag"]}" })[0],
                  view.serve("GET", "/", { "if-none-match" => "*" })[0]], [304, 304])
      check.call("a write to a file is 405; a miss, a directory, traversal or a bad escape 404",
                 [view.serve("POST", "/index.html", {})[0]] +
                 ["/nope", "/assets", "/..%2fwatcher.js", "/%E0%A4%A"].map { |p| view.serve("GET", p, {})[0] },
                 [405, 404, 404, 404, 404])
      check.call("the framework's helper is served at its alias",
                 view.serve("GET", "/_a2app/update.js", {})[1]["content-type"], "text/javascript; charset=utf-8")
      version = view.version
      File.write(File.join(public_dir, "index.html"), "<p>hi</p>")
      same = view.version
      File.write(File.join(public_dir, "index.html"), "<p>changed</p>")
      check.call("appVersion follows the bytes served, not their timestamps", [same == version, view.version == version],
                 [true, false])
    end

    if failures.any?
      puts "a2app_adapter selftest FAILED:\n  - " + failures.join("\n  - ")
      return 1
    end
    puts "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, " \
         "host and network policy, auth primitives, the ceiling and refusals, ownership, who reaches a task, " \
         "JavaScript values and RFC 8785, operations and tasks, device confirmation, persistence across a restart, " \
         "the View)"
    0
  end
end

if $PROGRAM_NAME == __FILE__
  if ARGV.include?("--selftest")
    exit A2appAdapter.selftest
  end
  puts "a2app_adapter is a library; Rails serves it (see config/routes.rb). Use --selftest to check rules parity."
end
