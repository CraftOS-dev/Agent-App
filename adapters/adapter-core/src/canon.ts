/**
 * Canonicalization + content-addressed approval keys.
 *
 * The approval key for a destructive operation is the SHA-256 (hex) of the
 * RFC 8785 (JSON Canonicalization Scheme) serialization of
 * `{ "operation": <name>, "args": <args> }`. Two implementations that both
 * follow RFC 8785 compute the same key, so "approve this exact call" is portable
 * across adapters.
 *
 * The JCS serializer below covers the JSON value subset A2App args use
 * (object · array · string · number · boolean · null):
 *   - object keys are sorted by UTF-16 code unit — the JS default string sort;
 *   - numbers use ECMAScript `Number.prototype.toString` (the shortest
 *     round-trip form RFC 8785 mandates) — `String(n)`;
 *   - strings use JSON minimal escaping, which matches JCS for the BMP.
 */
import { createHash } from "node:crypto";

/** RFC 8785 canonical JSON for the A2App arg value subset. */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    // Number.prototype.toString is the RFC 8785 number form (shortest round-trip).
    return String(v);
  }
  if (t === "string") return encodeString(v as string);
  if (Array.isArray(v)) return "[" + v.map(encode).join(",") + "]";
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code unit order
    return "{" + keys.map((k) => encodeString(k) + ":" + encode(obj[k])).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${t}`);
}

/** JSON minimal string escaping (matches JCS for BMP scalars). */
function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        if (code < 0x20) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

/**
 * The deterministic, content-addressed approval key for one exact operation
 * call. Same operation + same canonicalized args ⇒ same key; approving one call
 * approves no argument variant.
 */
export function approvalKey(operation: string, args: unknown): string {
  const canonical = canonicalize({ operation, args: args ?? {} });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** SHA-256 hex of arbitrary bytes, `sha256:`-prefixed — the ownership-canon /
 *  artifact hash form shared with the framework. */
export function sha256Prefixed(data: string): string {
  return "sha256:" + createHash("sha256").update(data, "utf8").digest("hex");
}
