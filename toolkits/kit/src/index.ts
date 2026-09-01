/**
 * @a2app/kit — the versioned kit a toolkit vendors into an Agent App: shared
 * View glue and a small browser A2App client. Vendored files are system-owned
 * (hash-locked in the ownership canon); an agent uses them but does not edit
 * them. Kept dependency-free so it drops into any stack.
 */
export const KIT_VERSION = "0.1.0";

/** A minimal browser client for the app's own data surface. Same-origin, so the
 *  origin rule treats it as the trusted UI path — no token needed. Mirrors the
 *  CLI/SDK record surface for the human View. */
export class BrowserDataClient {
  constructor(private readonly base = "") {}

  private path(entity: string): string {
    return `${this.base}/api/collections/${entity}/records`;
  }

  async list<T = Record<string, unknown>>(entity: string, query: { filter?: string; sort?: string } = {}): Promise<T[]> {
    const qs = new URLSearchParams();
    if (query.filter) qs.set("filter", query.filter);
    if (query.sort) qs.set("sort", query.sort);
    const res = await fetch(`${this.path(entity)}${qs.size ? `?${qs}` : ""}`);
    const json = (await res.json()) as { items?: T[] };
    return json.items ?? [];
  }
  async create<T = Record<string, unknown>>(entity: string, body: Record<string, unknown>): Promise<T> {
    return this.send<T>("POST", this.path(entity), body);
  }
  async update<T = Record<string, unknown>>(entity: string, id: string, body: Record<string, unknown>): Promise<T> {
    return this.send<T>("PATCH", `${this.path(entity)}/${id}`, body);
  }
  async remove(entity: string, id: string): Promise<void> {
    await fetch(`${this.path(entity)}/${id}`, { method: "DELETE" });
  }
  async identity(): Promise<{ app: { id: string; name?: string | null } } | null> {
    try {
      const res = await fetch(`${this.base}/api/_a2app`);
      return (await res.json()) as { app: { id: string; name?: string | null } };
    } catch {
      return null;
    }
  }
  private async send<T>(method: string, url: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  }
}

/**
 * Design tokens as a CSS string an app can inline. Defaults to the shadcn naming
 * convention so themes swap by overriding variables. Host/Display concern — not
 * a framework requirement.
 */
export const THEME_TOKENS = `:root{--background:#ffffff;--foreground:#0a0a0a;--muted:#f4f4f5;--muted-foreground:#6b7280;--border:#e4e4e7;--primary:#2563eb;--primary-foreground:#ffffff;--radius:0.5rem}@media(prefers-color-scheme:dark){:root{--background:#0a0a0a;--foreground:#fafafa;--muted:#18181b;--muted-foreground:#a1a1aa;--border:#27272a;--primary:#60a5fa;--primary-foreground:#0a0a0a}}`;
