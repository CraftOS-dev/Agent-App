/**
 * Zip archives, read and written with nothing but Node's zlib.
 *
 * A package travels as a zip (framework packaging §1) and a marketplace app
 * arrives inside a GitHub branch archive (§2), so this CLI reads archives it
 * did not make and must never trust them. Node ships raw deflate but no zip
 * container. The container is small enough to own outright, and owning it puts
 * every refusal §2 asks for at the one place an entry's name becomes a path,
 * rather than behind a library's own idea of "safe".
 *
 * Reading is random access from disk. The central directory is the index (the
 * only authoritative list of names and sizes), and each entry is streamed from
 * its byte range through inflate, so memory stays flat whatever the archive's
 * size. Sizes are counted as bytes arrive, never taken from the index alone: an
 * entry that inflates past what it declares is stopped there, and the checksum
 * is verified once it ends.
 *
 * Supported: stored and deflate entries, data descriptors, zip64, and UTF-8
 * names (flag bit 11, or the Info-ZIP Unicode path field; otherwise UTF-8 when
 * the bytes are valid UTF-8, else CP437, the format's own default). Refused by
 * name: encryption, any other compression method, multi-disk archives.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { assertRealInside } from "./fsx.js";
import { formatBytes, PackageRefusedError } from "./packageErrors.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;

/** The host byte of "version made by" for the systems whose attributes are Unix modes. */
const UNIX_HOSTS = new Set([3 /* Unix */, 19 /* OS X */]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
/** FILE_ATTRIBUTE_REPARSE_POINT: how a Windows-made archive marks a link. */
const DOS_REPARSE_POINT = 0x400;
const DOS_DIRECTORY = 0x10;

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** zlib.crc32 exists from Node 20.15 / 22.2; the table covers the rest of the engine range. */
const nativeCrc = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** CRC-32 (the zip polynomial), continuing from `previous`. */
export function crc32(data: Uint8Array, previous = 0): number {
  if (nativeCrc !== undefined) return nativeCrc(data, previous);
  let c = ~previous;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/* ------------------------------------------------------------------ names */

/** CP437's upper half: what a name without the UTF-8 flag means by the format's definition. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function cp437(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]!;
  return out;
}

function extraFields(extra: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) break;
    fields.set(id, extra.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return fields;
}

function decodeName(raw: Buffer, flags: number, extras: Map<number, Buffer>): string {
  if (flags & FLAG_UTF8) return raw.toString("utf8");
  // Info-ZIP's Unicode path field carries the UTF-8 name beside a legacy one,
  // valid only while its CRC still matches the legacy bytes it was written for.
  const unicode = extras.get(EXTRA_UNICODE_PATH);
  if (unicode !== undefined && unicode.length > 5 && unicode[0] === 1 && unicode.readUInt32LE(1) === crc32(raw)) {
    return unicode.subarray(5).toString("utf8");
  }
  try {
    return strictUtf8.decode(raw);
  } catch {
    return cp437(raw);
  }
}

/** Device names Windows resolves anywhere in a path, extension or not. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why a name can never be written inside a target directory, or null.
 *
 * Checked on the stored name, before anything is joined to a path: an absolute
 * path, a drive, a `..` segment or a `:` (a drive, or an NTFS alternate data
 * stream) all reach somewhere other than where the entry claims to live.
 * Backslashes count as separators, because Windows treats them as such.
 */
export function nameProblem(name: string): string | null {
  if (name.includes("\0")) return "has a NUL character in its name";
  if (/^[\\/]/.test(name)) return "is an absolute path";
  if (/^[A-Za-z]:/.test(name)) return "names a drive";
  for (const segment of name.split(/[\\/]/)) {
    if (segment === "..") return "climbs out of its folder with ..";
    if (segment.includes(":")) return "has a ':' in its name (a drive or an alternate data stream on Windows)";
    if (process.platform === "win32" && WINDOWS_DEVICE.test(segment)) return "names a Windows device";
  }
  return null;
}

/** A stored name as path segments: `/` and `\` both separate, empty and `.` segments drop. */
export function nameSegments(name: string): string[] {
  return name.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

/* ------------------------------------------------------------------ index */

export interface ZipEntry {
  /** the stored name, decoded */
  name: string;
  /** see {@link nameSegments} */
  segments: string[];
  directory: boolean;
  /** why this entry can never be extracted, or null when it can */
  problem: string | null;
  executable: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** offset of the entry's local header */
  offset: number;
  rawName: Buffer;
}

function refused(message: string): PackageRefusedError {
  return new PackageRefusedError(`the archive ${message}`);
}

/** Read exactly `length` bytes at `position`, or refuse a truncated archive. */
function readAt(fd: number, size: number, position: number, length: number): Buffer {
  if (position < 0 || position + length > size) throw refused("is truncated or not a zip");
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n === 0) throw refused("is truncated");
    got += n;
  }
  return buf;
}

function uint64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refused("declares a size no real archive has");
  return Number(value);
}

/**
 * Read an archive's central directory: every entry, with the reason it could
 * not be extracted where there is one. Throws {@link PackageRefusedError} when
 * the file is not a readable zip at all.
 */
export function readZipIndex(file: string): ZipEntry[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw refused("is not a zip (too short)");

    // The end-of-central-directory record sits in the last 22 bytes plus up to
    // a 64 KiB comment. Its signature can occur inside the comment, so a match
    // only counts when its comment length reaches exactly to the end.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tailStart = size - tailLength;
    const tail = readAt(fd, size, tailStart, tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLength) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw refused("is not a zip (no end-of-central-directory record)");
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw refused("spans several disks, which is not supported");
    }
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = readAt(fd, size, tailStart + eocd - 20, 20);
      if (locator.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw refused("is missing its zip64 locator");
      const record = readAt(fd, size, uint64(locator, 8), 56);
      if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw refused("is missing its zip64 end record");
      count = uint64(record, 32);
      cdSize = uint64(record, 40);
      cdOffset = uint64(record, 48);
    }
    if (cdOffset + cdSize > size) throw refused("has a central directory past its end");

    const cd = readAt(fd, size, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= cd.length && entries.length < count) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw refused("has a damaged central directory");
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLength + extraLength + commentLength;
      if (end > cd.length) throw refused("has a damaged central directory");
      const rawName = Buffer.from(cd.subarray(p + 46, p + 46 + nameLength));
      const extras = extraFields(cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));

      // zip64 sizes and offset, present only for the fields that overflowed.
      const zip64 = extras.get(EXTRA_ZIP64);
      if (zip64 !== undefined) {
        let q = 0;
        const next = (): number => {
          if (q + 8 > zip64.length) throw refused("has a damaged zip64 field");
          const v = uint64(zip64, q);
          q += 8;
          return v;
        };
        if (entrySize === 0xffffffff) entrySize = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (offset === 0xffffffff) offset = next();
      }

      const name = decodeName(rawName, flags, extras);
      const host = madeBy >>> 8;
      const unixMode = UNIX_HOSTS.has(host) ? external >>> 16 : 0;
      const type = unixMode & S_IFMT;
      const directory = /[\\/]$/.test(name) || type === S_IFDIR || (!UNIX_HOSTS.has(host) && (external & DOS_DIRECTORY) !== 0);
      const link = type === S_IFLNK || (!UNIX_HOSTS.has(host) && (external & DOS_REPARSE_POINT) !== 0);

      let problem = nameProblem(name);
      if (problem === null && link) problem = "is a link";
      if (problem === null && type !== 0 && type !== S_IFREG && type !== S_IFDIR) problem = "is not a regular file or folder";
      if (problem === null && flags & FLAG_ENCRYPTED) problem = "is encrypted";
      if (problem === null && !directory && method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        problem = `uses compression method ${method} (only stored and deflate are read)`;
      }

      entries.push({
        name,
        segments: nameSegments(name),
        directory,
        problem,
        executable: type === S_IFREG && (unixMode & 0o111) !== 0,
        method,
        crc32: crc,
        compressedSize,
        size: entrySize,
        offset,
        rawName,
      });
      p = end;
    }
    if (entries.length !== count) throw refused("lists fewer entries than it declares");
    return entries;
  } finally {
    closeSync(fd);
  }
}

/* -------------------------------------------------------------- extraction */

export interface ExtractOptions {
  /** extract only the entries under these leading segments, and drop them from the extracted paths */
  under: string[];
  /** refuse once the extracted files would exceed this many bytes */
  maxBytes: number;
  /**
   * Leave an entry out: given its extracted path, return the path that is being
   * left out (an enclosing folder, or the entry itself) or null to keep it.
   * Left-out entries are never written, so they are not checked either.
   */
  skip?: (rel: string[]) => string | null;
}

export interface Extracted {
  files: number;
  bytes: number;
  /** what `skip` left out, as the paths it named */
  skipped: string[];
}

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s);
}

/** Where an entry's data begins, after its local header — which must name the same file as the index. */
function dataOffset(fd: number, size: number, entry: ZipEntry): number {
  const header = readAt(fd, size, entry.offset, 30);
  if (header.readUInt32LE(0) !== SIG_LOCAL) throw refused(`has no local header for "${entry.name}"`);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  // Two names for one entry is how an archive shows one tool one file and
  // another tool a different one. The index is authoritative; a disagreeing
  // local header is refused rather than resolved.
  if (!readAt(fd, size, entry.offset + 30, nameLength).equals(entry.rawName)) {
    throw refused(`names "${entry.name}" differently in its index and its local header`);
  }
  const start = entry.offset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > size) throw refused(`is truncated inside "${entry.name}"`);
  return start;
}

/**
 * Extract the entries under `opts.under` into `dest` (which must be fresh: no
 * file is ever written over another). Every selected entry is checked before
 * the first byte is written, so a refusal leaves `dest` as it found it apart
 * from what the caller already staged there.
 *
 * Returns the number of files written, their total size, and what was skipped.
 */
export async function extractZip(file: string, index: ZipEntry[], dest: string, opts: ExtractOptions): Promise<Extracted> {
  const selected: { entry: ZipEntry; rel: string[] }[] = [];
  const seen = new Set<string>();
  const skipped = new Set<string>();
  for (const entry of index) {
    if (!startsWith(entry.segments, opts.under)) continue;
    const rel = entry.segments.slice(opts.under.length);
    if (rel.length === 0 && entry.problem === null) continue; // the folder entry itself
    const left = opts.skip?.(rel) ?? null;
    if (left !== null) {
      skipped.add(left);
      continue;
    }
    // Every selected entry is refused whatever it is, before anything is
    // written: checking only what is about to be written would let
    // `<folder>/../../x` through as a "skipped" entry on one platform and a
    // written one on another.
    if (entry.problem !== null) throw refused(`entry "${entry.name}" ${entry.problem}`);
    const key = rel.join("/");
    if (seen.has(key)) throw refused(`holds "${key}" twice`);
    seen.add(key);
    selected.push({ entry, rel });
  }

  const declared = selected.reduce((sum, s) => sum + (s.entry.directory ? 0 : s.entry.size), 0);
  if (declared > opts.maxBytes) {
    throw refused(`unpacks to ${formatBytes(declared)}, over the ${formatBytes(opts.maxBytes)} a package may hold`);
  }

  mkdirSync(dest, { recursive: true });
  const fd = openSync(file, "r");
  const size = fstatSync(fd).size;
  let written = 0;
  let files = 0;
  try {
    for (const { entry, rel } of selected) {
      const target = assertRealInside(dest, join(...rel), "archive entry");
      if (entry.directory) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const mode = entry.executable ? 0o755 : 0o644;
      if (entry.compressedSize === 0) {
        if (entry.size !== 0) throw refused(`entry "${entry.name}" declares content it does not hold`);
        writeFileSync(target, "", { flag: "wx", mode });
        files += 1;
        continue;
      }
      if (entry.method === METHOD_STORED && entry.compressedSize !== entry.size) {
        throw refused(`entry "${entry.name}" is stored with two different sizes`);
      }
      const start = dataOffset(fd, size, entry);
      let entryBytes = 0;
      let crc = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          entryBytes += chunk.length;
          written += chunk.length;
          if (entryBytes > entry.size) {
            done(refused(`entry "${entry.name}" unpacks past the ${formatBytes(entry.size)} it declares`));
            return;
          }
          if (written > opts.maxBytes) {
            done(refused(`unpacks past the ${formatBytes(opts.maxBytes)} a package may hold`));
            return;
          }
          crc = crc32(chunk, crc);
          done(null, chunk);
        },
      });
      const input = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
      const output = createWriteStream(target, { flags: "wx", mode });
      try {
        if (entry.method === METHOD_DEFLATE) await pipeline(input, zlib.createInflateRaw(), meter, output);
        else await pipeline(input, meter, output);
      } catch (err) {
        if (err instanceof PackageRefusedError) throw err;
        throw refused(`entry "${entry.name}" is corrupt: ${(err as Error).message}`);
      }
      if (entryBytes !== entry.size || crc !== entry.crc32) {
        throw refused(`entry "${entry.name}" is corrupt (its size or checksum does not match the index)`);
      }
      files += 1;
    }
  } finally {
    closeSync(fd);
  }
  return { files, bytes: written, skipped: [...skipped].sort() };
}

/* ----------------------------------------------------------------- writing */

/** One archive entry to write: a file on disk, bytes in memory, or a folder (name ending `/`). */
export type ZipSource =
  | { name: string; file: string }
  | { name: string; data: Buffer }
  | { name: string; directory: true };

export interface WrittenZip {
  bytes: number;
  sha256: string;
  entries: number;
}

/** DOS date and time, the only clock zip's fixed headers carry. */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
  };
}

/**
 * Write `sources` as a new archive at `out` (which must not exist). Every file
 * is streamed through deflate with a data descriptor, so no file is held in
 * memory whole; names are written as UTF-8 and flagged so. Unix modes are
 * recorded so an executable stays executable where that means something.
 *
 * Without zip64, which a package never needs: the caps on a package keep it far
 * below 4 GiB and 65,535 entries, and an archive past either is refused here.
 */
export async function writeZip(out: string, sources: ZipSource[]): Promise<WrittenZip> {
  if (sources.length > 0xffff) throw new PackageRefusedError(`a package holds at most 65,535 entries (this one has ${sources.length})`);
  const fd = openSync(out, "wx");
  const hash = createHash("sha256");
  let position = 0;
  const write = (buf: Buffer): void => {
    let done = 0;
    while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done);
    hash.update(buf);
    position += buf.length;
  };
  const central: Buffer[] = [];
  try {
    for (const source of sources) {
      const isDirectory = "directory" in source;
      const name = Buffer.from(isDirectory && !source.name.endsWith("/") ? `${source.name}/` : source.name, "utf8");
      const stat = "file" in source ? statSync(source.file) : null;
      const executable = stat !== null && process.platform !== "win32" && (stat.mode & 0o111) !== 0;
      const { date, time } = dosDateTime(stat?.mtime ?? new Date());
      const flags = isDirectory ? FLAG_UTF8 : FLAG_UTF8 | FLAG_DESCRIPTOR;
      const method = isDirectory ? METHOD_STORED : METHOD_DEFLATE;
      const offset = position;
      if (offset > 0xfffffffe) throw new PackageRefusedError("the package is too large for an archive without zip64");

      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      write(local);
      write(name);

      let crc = 0;
      let size = 0;
      let compressed = 0;
      if (!isDirectory) {
        const input = "file" in source ? createReadStream(source.file) : Readable.from([source.data]);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            done(null, chunk);
          },
        });
        const sink = new Writable({
          write(chunk: Buffer, _encoding, done) {
            try {
              write(chunk);
              compressed += chunk.length;
              done();
            } catch (err) {
              done(err as Error);
            }
          },
        });
        await pipeline(input, meter, zlib.createDeflateRaw(), sink);
        if (size > 0xfffffffe || compressed > 0xfffffffe) {
          throw new PackageRefusedError(`${source.name} is too large for an archive without zip64`);
        }
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
        descriptor.writeUInt32LE(crc, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        write(descriptor);
      }

      const mode = isDirectory ? S_IFDIR | 0o755 : S_IFREG | (executable ? 0o755 : 0o644);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(SIG_CENTRAL, 0);
      entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is read
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(flags, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(compressed, 20);
      entry.writeUInt32LE(size, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(((mode << 16) | (isDirectory ? DOS_DIRECTORY : 0)) >>> 0, 38);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
    }

    const cdOffset = position;
    for (const part of central) write(part);
    const cdSize = position - cdOffset;
    if (position > 0xfffffffe) throw new PackageRefusedError("the package is too large for an archive without zip64");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(sources.length, 8);
    end.writeUInt16LE(sources.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdOffset, 16);
    write(end);
  } finally {
    closeSync(fd);
  }
  return { bytes: position, sha256: hash.digest("hex"), entries: sources.length };
}
