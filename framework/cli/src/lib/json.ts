/**
 * Read a JSON file the framework did not necessarily write itself.
 *
 * PowerShell 5's `Set-Content -Encoding utf8` (and Notepad's "UTF-8 with BOM")
 * prepend a byte-order mark, which `JSON.parse` rejects with
 * `Unexpected token '﻿'` — an invisible character, no file name, nothing about
 * encoding. Node's own `.json` loader and npm strip the BOM; so does this. A
 * file that still fails to parse is reported under its own path.
 */
import { readFileSync } from "node:fs";

export function readJsonFile<T = unknown>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
}
