/**
 * The zip reader and writer (src/lib/zip.ts): what install reads from a stranger
 * and what export hands to one.
 *
 * Archives here are built two ways: by the CLI's own writer (round trips), and
 * byte by byte with `rawZip` below, so the reader meets the shapes other tools
 * write — stored entries, deflate without a data descriptor, CP437 names, the
 * Info-ZIP Unicode path field, zip64 — and every malicious shape it must refuse.
 *
 * Standard library only, run directly. No network.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { crc32, extractZip, readZipIndex, writeZip } from "../dist/lib/zip.js";
import { PackageRefusedError } from "../dist/lib/packageErrors.js";

const base = mkdtempSync(join(tmpdir(), "a2app-zip-"));
let n = 0;
const fresh = () => join(base, `case-${n++}`);
const MB = 1024 * 1024;

/**
 * Build an archive byte by byte. Each entry: { name, data?, method?, flags?,
 * madeBy?, external?, crc?, size?, compressed? (raw bytes as stored),
 * localName?, descriptor?, extra? }.
 */
function rawZip(entries, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const stored = e.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const nameBytes = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "utf8");
    const localName = e.localName !== undefined ? Buffer.from(e.localName, "utf8") : nameBytes;
    const flags = e.flags ?? (Buffer.isBuffer(e.name) ? 0 : 0x0800);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const extra = e.extra ?? Buffer.alloc(0);
    const descriptor = e.descriptor === true;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags | (descriptor ? 0x0008 : 0), 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : stored.length, 18);
    local.writeUInt32LE(descriptor ? 0 : size, 22);
    local.writeUInt16LE(localName.length, 26);
    const parts = [local, localName, stored];
    if (descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(stored.length, 8);
      d.writeUInt32LE(size, 12);
      parts.push(d);
    }
    const block = Buffer.concat(parts);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags | (descriptor ? 0x0008 : 0), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((e.external ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes, extra]));
    locals.push(block);
    offset += block.length;
  }
  const cd = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tail, end]);
}

function saveZip(buffer) {
  const file = `${fresh()}.zip`;
  writeFileSync(file, buffer);
  return file;
}

async function extractAll(file, opts = {}) {
  const dest = fresh();
  const index = readZipIndex(file);
  const result = await extractZip(file, index, dest, { under: [], maxBytes: 512 * MB, ...opts });
  return { dest, index, result };
}

async function refuses(buffer, pattern, opts = {}) {
  const file = saveZip(buffer);
  await assert.rejects(
    async () => extractAll(file, opts),
    (err) => err instanceof PackageRefusedError && pattern.test(err.message),
    `expected a refusal matching ${pattern}`,
  );
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------- round trip */

test("the writer's archives read back byte for byte", async () => {
  const src = fresh();
  mkdirSync(join(src, "nested", "deeper"), { recursive: true });
  const files = {
    "plain.txt": Buffer.from("hello\n"),
    "empty.txt": Buffer.alloc(0),
    "nested/deeper/big.txt": Buffer.from("compressible line\n".repeat(20_000)),
    "nested/binary.bin": Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 256)),
    "réf/日本語 名前.md": Buffer.from("# utf-8 names\n"),
  };
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(src, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(src, ...rel.split("/")), data);
  }
  if (process.platform !== "win32") chmodSync(join(src, "plain.txt"), 0o755);
  const out = `${fresh()}.zip`;
  const sources = [
    { name: "app/", directory: true },
    { name: "app/empty-folder/", directory: true },
    ...Object.keys(files).map((rel) => ({ name: `app/${rel}`, file: join(src, ...rel.split("/")) })),
    { name: "app/in-memory.json", data: Buffer.from('{"id":"x"}\n') },
  ];
  const written = await writeZip(out, sources);
  assert.equal(written.entries, sources.length);
  assert.equal(written.bytes, statSync(out).size);
  assert.match(written.sha256, /^[0-9a-f]{64}$/);

  const { dest, result } = await extractAll(out, { under: ["app"] });
  for (const [rel, data] of Object.entries(files)) {
    assert.deepEqual(readFileSync(join(dest, ...rel.split("/"))), data, rel);
  }
  assert.equal(readFileSync(join(dest, "in-memory.json"), "utf8"), '{"id":"x"}\n');
  assert.ok(statSync(join(dest, "empty-folder")).isDirectory(), "an empty folder survives");
  assert.equal(result.files, Object.keys(files).length + 1);
  if (process.platform !== "win32") assert.ok((statSync(join(dest, "plain.txt")).mode & 0o111) !== 0, "the executable bit survives");
});

test("an archive is never written over an existing file", async () => {
  const out = `${fresh()}.zip`;
  writeFileSync(out, "precious");
  await assert.rejects(() => writeZip(out, [{ name: "a.txt", data: Buffer.from("a") }]), /EEXIST/);
  assert.equal(readFileSync(out, "utf8"), "precious");
});

/* ------------------------------------------------------- other tools' shapes */

test("stored entries, deflate without a descriptor, and deflate with one", async () => {
  const file = saveZip(
    rawZip([
      { name: "stored.txt", data: Buffer.from("stored bytes"), method: 0 },
      { name: "deflated.txt", data: Buffer.from("deflated ".repeat(100)) },
      { name: "described.txt", data: Buffer.from("described ".repeat(100)), descriptor: true },
    ]),
  );
  const { dest } = await extractAll(file);
  assert.equal(readFileSync(join(dest, "stored.txt"), "utf8"), "stored bytes");
  assert.equal(readFileSync(join(dest, "deflated.txt"), "utf8"), "deflated ".repeat(100));
  assert.equal(readFileSync(join(dest, "described.txt"), "utf8"), "described ".repeat(100));
});

test("names: the UTF-8 flag, the Unicode path field, plain UTF-8, and CP437", async () => {
  const legacy = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]); // "caf\x82.txt" — é in CP437
  const unicodeField = (() => {
    const name = Buffer.from("légende.txt", "utf8");
    const raw = Buffer.from("l?gende.txt", "latin1");
    const body = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), name]);
    body.writeUInt32LE(crc32(raw), 1);
    const header = Buffer.alloc(4);
    header.writeUInt16LE(0x7075, 0);
    header.writeUInt16LE(body.length, 2);
    return { raw, extra: Buffer.concat([header, body]) };
  })();
  const file = saveZip(
    rawZip([
      { name: "flagged-ü.txt", data: Buffer.from("1") },
      { name: Buffer.from("unflagged-ü.txt", "utf8"), data: Buffer.from("2") },
      { name: legacy, data: Buffer.from("3") },
      { name: unicodeField.raw, extra: unicodeField.extra, data: Buffer.from("4") },
    ]),
  );
  const names = readZipIndex(file).map((e) => e.name);
  assert.deepEqual(names, ["flagged-ü.txt", "unflagged-ü.txt", "café.txt", "légende.txt"]);
  const { dest } = await extractAll(file);
  assert.equal(readFileSync(join(dest, "café.txt"), "utf8"), "3");
});

test("zip64 end records are read", async () => {
  const file = saveZip(rawZip([{ name: "a.txt", data: Buffer.from("zip64") }], { zip64: true }));
  const index = readZipIndex(file);
  assert.equal(index.length, 1);
  const { dest } = await extractAll(file);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "zip64");
});

test("a folder is taken by whole path segments, never by prefix", async () => {
  const file = saveZip(
    rawZip([
      { name: "repo-main/app/x.txt", data: Buffer.from("x") },
      { name: "repo-main/app-other/y.txt", data: Buffer.from("y") },
      { name: "repo-main/application/z.txt", data: Buffer.from("z") },
      { name: "repo-main/app/sub/w.txt", data: Buffer.from("w") },
    ]),
  );
  const { dest } = await extractAll(file, { under: ["repo-main", "app"] });
  assert.deepEqual(readdirSync(dest).sort(), ["sub", "x.txt"]);
});

test("a skipped folder is never extracted, so its links never block a package", async () => {
  const file = saveZip(
    rawZip([
      { name: "keep.txt", data: Buffer.from("k") },
      { name: "node_modules/.bin/tool", data: Buffer.from("../x/tool"), madeBy: 3 << 8, external: (0o120777 << 16) >>> 0 },
    ]),
  );
  const skip = (rel) => (rel[0] === "node_modules" ? "node_modules/" : null);
  const { dest, result } = await extractAll(file, { skip });
  assert.deepEqual(readdirSync(dest), ["keep.txt"]);
  assert.deepEqual(result.skipped, ["node_modules/"]);
});

/* ----------------------------------------------------------------- refusals */

test("absolute paths are refused", () => refuses(rawZip([{ name: "/etc/evil", data: Buffer.from("x") }]), /absolute path/));
test("backslash-absolute paths are refused", () => refuses(rawZip([{ name: "\\evil.txt", data: Buffer.from("x") }]), /absolute path/));
test("drive letters are refused", () => refuses(rawZip([{ name: "C:/evil.txt", data: Buffer.from("x") }]), /names a drive/));
test("`..` is refused", () => refuses(rawZip([{ name: "../evil.txt", data: Buffer.from("x") }]), /climbs out/));
test("`..` after a folder is refused", () => refuses(rawZip([{ name: "app/../../evil.txt", data: Buffer.from("x") }]), /climbs out/));
test("`..` with backslashes is refused", () => refuses(rawZip([{ name: "app\\..\\..\\evil.txt", data: Buffer.from("x") }]), /climbs out/));
test("a ':' (an alternate data stream) is refused", () => refuses(rawZip([{ name: "file.txt:stream", data: Buffer.from("x") }]), /':'/));
test("a Unix link entry is refused", () =>
  refuses(rawZip([{ name: "link", data: Buffer.from("/etc/passwd"), madeBy: 3 << 8, external: (0o120777 << 16) >>> 0 }]), /is a link/));
test("a Windows reparse-point entry is refused", () =>
  refuses(rawZip([{ name: "junction", data: Buffer.from(""), madeBy: 10 << 8, external: 0x400 }]), /is a link/));
test("a device or FIFO entry is refused", () =>
  refuses(rawZip([{ name: "fifo", data: Buffer.from(""), madeBy: 3 << 8, external: (0o010644 << 16) >>> 0 }]), /not a regular file/));
test("encrypted entries are refused", () => refuses(rawZip([{ name: "secret.txt", data: Buffer.from("x"), flags: 0x0801 }]), /encrypted/));
test("unknown compression methods are refused", () =>
  refuses(rawZip([{ name: "a.bz2", data: Buffer.from("x"), method: 12, compressed: Buffer.from("x") }]), /compression method 12/));
test("a local header naming another file is refused", () =>
  refuses(rawZip([{ name: "innocent.txt", localName: "../../evil.txt", data: Buffer.from("x") }]), /differently/));
test("the same path twice is refused", () =>
  refuses(rawZip([{ name: "a.txt", data: Buffer.from("1") }, { name: "./a.txt", data: Buffer.from("2") }]), /twice/));
test("an entry declaring more than the cap is refused before anything is written", async () => {
  const dest = fresh();
  const file = saveZip(rawZip([{ name: "big.bin", data: Buffer.from("small"), size: 600 * MB }]));
  await assert.rejects(() => extractZip(file, readZipIndex(file), dest, { under: [], maxBytes: 512 * MB }), /over the 512 MiB/);
  assert.equal(existsSync(dest), false, "nothing was created");
});
test("entries that together exceed the cap are refused", () =>
  refuses(rawZip([{ name: "a", data: Buffer.alloc(60) }, { name: "b", data: Buffer.alloc(60) }]), /over the 100 B/, { maxBytes: 100 }));
test("an entry that inflates past its declared size is stopped there", () =>
  refuses(rawZip([{ name: "bomb", data: Buffer.alloc(1_000_000), size: 10 }]), /past the 10 B it declares/));
test("a checksum mismatch is refused", () => refuses(rawZip([{ name: "a.txt", data: Buffer.from("abc"), method: 0, crc: 1 }]), /corrupt/));
test("a file that is not a zip is refused", async () => {
  const file = saveZip(Buffer.from("this is not an archive at all, just text that is long enough"));
  assert.throws(() => readZipIndex(file), (err) => err instanceof PackageRefusedError && /not a zip/.test(err.message));
});
test("a truncated archive is refused", async () => {
  const whole = rawZip([{ name: "a.txt", data: Buffer.from("abc".repeat(100)) }]);
  const file = saveZip(whole.subarray(0, whole.length - 10));
  assert.throws(() => readZipIndex(file), PackageRefusedError);
});
if (process.platform === "win32") {
  test("Windows device names are refused", () => refuses(rawZip([{ name: "app/CON.txt", data: Buffer.from("x") }]), /Windows device/));
}

/* ------------------------------------------------------------------- run */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(err?.stack ?? err).split("\n").join("\n    ")}`);
  }
}
rmSync(base, { recursive: true, force: true });
if (failed > 0) {
  console.error(`✗ zip: ${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`✓ zip: ${tests.length} passed`);
