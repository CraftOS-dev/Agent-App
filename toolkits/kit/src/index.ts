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
 * The kit design tokens as a CSS string an app can inline or serve.
 *
 * A two-tier system: Tier-1 primitives (raw palette) → Tier-2 semantic aliases.
 * Components consume ONLY Tier-2, so a theme is a re-point of Tier-2 and never
 * a component edit. Both schemes (light, and dark via `prefers-color-scheme` or
 * an explicit `data-theme="dark"` on the root) resolve every semantic token on
 * their own — contrast pairs hold WCAG AA in each.
 *
 * The blueprints vendor this same sheet as `public/tokens.css`; the two are kept
 * in lockstep (this constant is the source of truth for the token *names* —
 * an app themes by re-pointing values, never by renaming).
 */
export const DESIGN_TOKENS_CSS = `/* Agent App kit design tokens — two tiers: primitives, then semantic aliases.
   Components consume ONLY the semantic tier. Theme = re-point the semantic tier. */
:root {
  /* Tier 1: primitives */
  --slate-50:#f8fafc; --slate-100:#f1f5f9; --slate-200:#e2e8f0; --slate-300:#cbd5e1;
  --slate-400:#94a3b8; --slate-500:#64748b; --slate-600:#475569; --slate-700:#334155;
  --slate-800:#1e293b; --slate-900:#0f172a;
  --indigo-50:#eef2ff; --indigo-200:#c7d2fe; --indigo-300:#a5b4fc; --indigo-400:#818cf8;
  --indigo-500:#6366f1; --indigo-600:#4f46e5; --indigo-700:#4338ca;
  --green-50:#f0fdf4; --green-400:#4ade80; --green-500:#22c55e; --green-600:#16a34a; --green-700:#15803d; --green-100:#dcfce7;
  --amber-50:#fffbeb; --amber-400:#fbbf24; --amber-500:#f59e0b; --amber-700:#b45309; --amber-100:#fef3c7;
  --red-50:#fef2f2; --red-400:#f87171; --red-500:#ef4444; --red-600:#dc2626; --red-700:#b91c1c; --red-100:#fee2e2;
  --blue-50:#eff6ff; --blue-400:#60a5fa; --blue-500:#3b82f6; --blue-600:#2563eb; --blue-700:#1d4ed8; --blue-100:#dbeafe;

  /* Tier 2: semantic (light) */
  --bg-canvas:var(--slate-100); --bg-surface:#ffffff; --bg-raised:#ffffff;
  --bg-sunken:var(--slate-50); --bg-hover:var(--slate-100); --bg-active:var(--slate-200);
  --bg-selected:var(--indigo-50);
  --text-primary:var(--slate-900); --text-secondary:var(--slate-600);
  --text-tertiary:var(--slate-500); --text-disabled:var(--slate-400);
  --text-on-accent:#ffffff;
  --border-subtle:var(--slate-200); --border-default:var(--slate-300); --border-strong:var(--slate-400);
  --accent-solid:var(--indigo-600); --accent-hover:var(--indigo-700); --accent-text:var(--indigo-700);
  --accent-bg:var(--indigo-50); --accent-border:var(--indigo-200); --focus-ring:var(--indigo-500);
  --success-solid:var(--green-600); --success-text:var(--green-700); --success-bg:var(--green-50); --success-border:var(--green-100);
  --warning-solid:var(--amber-500); --warning-text:var(--amber-700); --warning-bg:var(--amber-50); --warning-border:var(--amber-100);
  --danger-solid:var(--red-600);   --danger-text:var(--red-700);   --danger-bg:var(--red-50);   --danger-border:var(--red-100);
  --info-solid:var(--blue-600);    --info-text:var(--blue-700);    --info-bg:var(--blue-50);    --info-border:var(--blue-100);
  --neutral-text:var(--slate-600); --neutral-bg:var(--slate-100);  --neutral-border:var(--slate-200);

  /* spacing (4px grid) */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
  --sp-8:32px; --sp-10:40px; --sp-12:48px; --sp-16:64px;

  /* radius */
  --r-sm:4px; --r-md:6px; --r-lg:8px; --r-xl:12px; --r-full:9999px;

  /* typography */
  --font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --fs-xs:12px; --fs-sm:13px; --fs-base:14px; --fs-md:15px; --fs-lg:16px; --fs-xl:20px; --fs-2xl:24px;
  --lh-tight:1.25; --lh-normal:1.5;
  --fw-regular:400; --fw-medium:500; --fw-semibold:600; --fw-bold:700;

  /* elevation */
  --sh-1:0 1px 2px rgb(16 24 40 / .06), 0 1px 3px rgb(16 24 40 / .10);
  --sh-2:0 2px 4px rgb(16 24 40 / .06), 0 4px 8px rgb(16 24 40 / .08);
  --sh-3:0 4px 6px rgb(16 24 40 / .05), 0 10px 20px rgb(16 24 40 / .12);
  --sh-4:0 8px 16px rgb(16 24 40 / .10), 0 16px 32px rgb(16 24 40 / .16);

  /* motion */
  --dur-fast:120ms; --dur-mid:200ms; --dur-slow:300ms;
  --ease-out:cubic-bezier(0.16,1,0.3,1); --ease-std:cubic-bezier(0.4,0,0.2,1);

  /* controls */
  --control-h:36px; --row-h:44px;
}

[data-theme="dark"] {
  --bg-canvas:#0b1220; --bg-surface:#111a2b; --bg-raised:#16223a;
  --bg-sunken:#0d1526; --bg-hover:#1a2740; --bg-active:#22314f; --bg-selected:#1e2a4a;
  --text-primary:#eef2f8; --text-secondary:#9aa8bd; --text-tertiary:#8494ad; --text-disabled:#61708a;
  --text-on-accent:#ffffff;
  --border-subtle:#1e2a40; --border-default:#2a3a56; --border-strong:#3b4d6e;
  --accent-solid:var(--indigo-500); --accent-hover:var(--indigo-400); --accent-text:var(--indigo-300);
  --accent-bg:rgba(99,102,241,.14); --accent-border:rgba(99,102,241,.3); --focus-ring:var(--indigo-400);
  --success-solid:var(--green-500); --success-text:var(--green-400); --success-bg:rgba(34,197,94,.12); --success-border:rgba(34,197,94,.22);
  --warning-solid:var(--amber-500); --warning-text:var(--amber-400); --warning-bg:rgba(245,158,11,.12); --warning-border:rgba(245,158,11,.22);
  --danger-solid:var(--red-500);    --danger-text:var(--red-400);    --danger-bg:rgba(239,68,68,.12);   --danger-border:rgba(239,68,68,.22);
  --info-solid:var(--blue-500);     --info-text:var(--blue-400);     --info-bg:rgba(59,130,246,.12);    --info-border:rgba(59,130,246,.22);
  --neutral-text:var(--slate-300);  --neutral-bg:rgba(148,163,184,.12); --neutral-border:rgba(148,163,184,.2);
  --sh-1:0 1px 2px rgb(0 0 0 / .4); --sh-2:0 2px 8px rgb(0 0 0 / .45);
  --sh-3:0 8px 20px rgb(0 0 0 / .5); --sh-4:0 16px 32px rgb(0 0 0 / .55);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg-canvas:#0b1220; --bg-surface:#111a2b; --bg-raised:#16223a;
    --bg-sunken:#0d1526; --bg-hover:#1a2740; --bg-active:#22314f; --bg-selected:#1e2a4a;
    --text-primary:#eef2f8; --text-secondary:#9aa8bd; --text-tertiary:#8494ad; --text-disabled:#61708a;
    --text-on-accent:#ffffff;
    --border-subtle:#1e2a40; --border-default:#2a3a56; --border-strong:#3b4d6e;
    --accent-solid:var(--indigo-500); --accent-hover:var(--indigo-400); --accent-text:var(--indigo-300);
    --accent-bg:rgba(99,102,241,.14); --accent-border:rgba(99,102,241,.3); --focus-ring:var(--indigo-400);
    --success-solid:var(--green-500); --success-text:var(--green-400); --success-bg:rgba(34,197,94,.12); --success-border:rgba(34,197,94,.22);
    --warning-solid:var(--amber-500); --warning-text:var(--amber-400); --warning-bg:rgba(245,158,11,.12); --warning-border:rgba(245,158,11,.22);
    --danger-solid:var(--red-500);    --danger-text:var(--red-400);    --danger-bg:rgba(239,68,68,.12);   --danger-border:rgba(239,68,68,.22);
    --info-solid:var(--blue-500);     --info-text:var(--blue-400);     --info-bg:rgba(59,130,246,.12);    --info-border:rgba(59,130,246,.22);
    --neutral-text:var(--slate-300);  --neutral-bg:rgba(148,163,184,.12); --neutral-border:rgba(148,163,184,.2);
    --sh-1:0 1px 2px rgb(0 0 0 / .4); --sh-2:0 2px 8px rgb(0 0 0 / .45);
    --sh-3:0 8px 20px rgb(0 0 0 / .5); --sh-4:0 16px 32px rgb(0 0 0 / .55);
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
`;