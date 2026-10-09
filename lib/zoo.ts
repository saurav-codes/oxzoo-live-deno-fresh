// Zoo contract helpers (oxzoo-live DESIGN.md): health, probe, CORS, zoo-sig v1,
// trace ring, rate limit. Web Request/Response only, so every framework can use it.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_BODY = 64 * 1024;
const SIG_RE = /^t=(\d{1,12}),caller=([a-z0-9-]{1,40}),sig=([0-9a-f]{64})$/;
const startedAt = new Date();

export interface AppInfo {
  name: string;
  stack: string;
  build?: { tag?: string; built_at?: string };
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
  env: string[];
  hops: string[];
}

export interface CheckCtx {
  signal: AbortSignal;
  hops: string[];
}

export interface CheckSpec {
  id: string;
  label: string;
  env: string[];
  cross?: boolean; // cross-server: 8 s instead of 5 s
  run: (ctx: CheckCtx) => Promise<string | void>;
}

export type Role = "signs" | "verifies" | "reference" | "service" | "secret" | "url" | "plain";

export interface Var {
  name: string;
  role: Role;
  fp?: string;
  value?: string;
  peer?: string;
  missing?: true;
}

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function serverLabel(publicHost = env("PUBLIC_HOST")): string {
  return (publicHost ?? "").split(".").find((l) => /^s[0-9]+$/.test(l)) ?? "local";
}

function runtime(): string {
  const deno = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
  return deno ? `deno ${deno.version.deno}` : `node ${process.versions.node}`;
}

function identity(info: AppInfo) {
  return {
    name: info.name,
    stack: info.stack,
    server: serverLabel(),
    release: (env("OX_RELEASE") ?? "unknown").slice(0, 12),
    env: env("OX_ENV") ?? "local",
  };
}

export function health(info: AppInfo) {
  const build: Record<string, string> = {};
  if (info.build?.tag) build.tag = info.build.tag;
  if (info.build?.built_at) build.built_at = info.build.built_at;
  build.runtime = runtime();
  return {
    ...identity(info),
    uptime_s: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    started_at: startedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    build,
  };
}

export function me(info: AppInfo): string {
  return `${info.name}@${serverLabel()}`;
}

// ---- CORS ----

function allowedOrigins(): string[] {
  return (env("ZOO_PANEL_ORIGIN") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

export function preflight(req: Request): Response {
  const cors = corsHeaders(req);
  if (!cors["Access-Control-Allow-Origin"]) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export function json(req: Request | null, status: number, body: unknown, cors = true): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(cors && req ? corsHeaders(req) : {}),
    },
  });
}

// ---- zoo-sig v1 ----

export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function fp(value: string): string {
  return sha256hex(value).slice(-4);
}

export function signature(key: string, t: number, method: string, path: string, body: string | Uint8Array = ""): string {
  return createHmac("sha256", key).update(`${t}.${method.toUpperCase()}.${path}.${sha256hex(body)}`).digest("hex");
}

export function signHeader(key: string, caller: string, method: string, path: string, body: string | Uint8Array = "", now = Date.now() / 1000): string {
  const t = Math.floor(now);
  return `t=${t},caller=${caller},sig=${signature(key, t, method, path, body)}`;
}

export type Verdict = { ok: true; caller: string } | { ok: false; error: string };

export function verifySignature(header: string | null, key: string, allow: string[], method: string, path: string, body: string | Uint8Array, now = Date.now() / 1000): Verdict {
  if (!header) return { ok: false, error: "missing signature" };
  const m = SIG_RE.exec(header.trim());
  if (!m) return { ok: false, error: "bad format" };
  const t = Number(m[1]);
  if (Math.abs(now - t) > 300) return { ok: false, error: "expired" };
  if (!allow.includes(m[2])) return { ok: false, error: "unknown caller" };
  const want = Buffer.from(signature(key, t, method, path, body), "hex");
  const got = Buffer.from(m[3], "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, error: "bad signature" };
  return { ok: true, caller: m[2] };
}

export async function readCapped(stream: ReadableStream<Uint8Array> | null, cap = MAX_BODY): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`body larger than ${cap} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface SignedOpts {
  method?: string;
  body?: string;
  trace?: string;
  signal?: AbortSignal;
}

export function signedFetch(url: string, key: string, caller: string, opts: SignedOpts = {}): Promise<Response> {
  const u = new URL(url);
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "X-Zoo-Signature": signHeader(key, caller, method, u.pathname + u.search, opts.body ?? ""),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.trace) headers["X-Zoo-Trace"] = opts.trace;
  return fetch(u, { method, headers, body: opts.body, signal: opts.signal ?? AbortSignal.timeout(8000), redirect: "manual" });
}

export async function readJSON(res: Response): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readCapped(res.body));
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new Error(`status ${res.status}, body is not JSON`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// peerCheck calls the peer's /_zoo/verify signed and proves name, key and URL value.
export function peerCheck(info: AppInfo, peer: string, urlVar: string, keyVar: string): CheckSpec {
  return {
    id: `peer:${peer}`,
    label: `Signed call to ${peer}`,
    env: [urlVar, keyVar],
    cross: true,
    async run(ctx) {
      const url = trimSlash(env(urlVar)!);
      const key = env(keyVar)!;
      const res = await signedFetch(`${url}/_zoo/verify`, key, info.name, { signal: ctx.signal });
      const body = await readJSON(res);
      if (body.server) ctx.hops.push(`${peer}@${body.server}`);
      if (res.status !== 200) throw new Error(`status ${res.status}${body.error ? `: ${body.error}` : ""}`);
      if (body.name !== peer) throw new Error(`peer name is ${JSON.stringify(body.name)}, want ${peer}`);
      if (body.key_fp !== fp(key)) throw new Error(`peer key_fp ${body.key_fp} != ours ${fp(key)}`);
      if (trimSlash(String(body.public_url ?? "")) !== url) throw new Error(`peer public_url ${body.public_url} != ${urlVar}`);
      return `verified by ${peer} with ${keyVar}, key_fp ${fp(key)}`;
    },
  };
}

// ---- probe ----

export function variable(name: string, role: Role, opts: { peer?: string; show?: boolean } = {}): Var {
  const value = env(name);
  const out: Var = { name, role };
  if (opts.peer) out.peer = opts.peer;
  if (value === undefined) return { ...out, missing: true };
  out.fp = fp(value);
  if (opts.show) out.value = value;
  return out;
}

function sleep(ms: number): { done: Promise<void>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((r) => (id = setTimeout(r, ms)));
  return { done, cancel: () => clearTimeout(id) };
}

async function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  const s = sleep(ms);
  try {
    return await Promise.race([p, s.done.then(() => Promise.reject(new Error(`timeout after ${ms} ms`)))]);
  } finally {
    s.cancel();
  }
}

// errorText names timeouts plainly and adds the cause fetch hides ("fetch failed: ECONNREFUSED").
export function errorText(err: Error, timeoutMs: number): string {
  if (err.name === "TimeoutError" || err.name === "AbortError") return `timeout after ${timeoutMs} ms`;
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return cause ? `${err.message}: ${cause.code ?? cause.message}` : err.message;
}

export async function runCheck(info: AppInfo, spec: CheckSpec): Promise<Check> {
  const t0 = Date.now();
  const ctx: CheckCtx = { signal: AbortSignal.timeout(spec.cross ? 8000 : 5000), hops: [me(info)] };
  const out: Check = { id: spec.id, label: spec.label, ok: false, ms: 0, env: spec.env, hops: ctx.hops };
  const missing = spec.env.find((n) => env(n) === undefined);
  try {
    if (missing) throw new Error(`${missing} is not set`);
    const detail = await bounded(spec.run(ctx), spec.cross ? 8000 : 5000);
    if (detail) out.detail = detail;
    out.ok = true;
  } catch (e) {
    out.error = errorText(e as Error, spec.cross ? 8000 : 5000);
  }
  out.ms = Date.now() - t0;
  return out;
}

let busy: Promise<void> | null = null;

// withProbeLock runs one probe at a time; a second waits up to waitMs, then gets null.
export async function withProbeLock<T>(fn: () => Promise<T>, waitMs = 5000): Promise<T | null> {
  const deadline = Date.now() + waitMs;
  while (busy) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const s = sleep(left);
    await Promise.race([busy, s.done]);
    s.cancel();
  }
  let release!: () => void;
  busy = new Promise((r) => (release = r));
  try {
    return await fn();
  } finally {
    busy = null;
    release();
  }
}

export async function probe(req: Request, info: AppInfo, specs: CheckSpec[], vars: Var[]): Promise<Response> {
  try {
    const body = await withProbeLock(async () => {
      const t0 = Date.now();
      const checks = await bounded(Promise.all(specs.map((s) => runCheck(info, s))), 20000);
      return {
        ...identity(info),
        ok: checks.every((c) => c.ok),
        ms: Date.now() - t0,
        at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        checks,
        vars,
      };
    });
    if (!body) return json(req, 429, { error: "probe busy" });
    return json(req, 200, body);
  } catch (e) {
    console.error("probe failed:", (e as Error).message);
    return json(req, 500, { error: (e as Error).message });
  }
}

// ---- chains and traces ----

export interface Hop {
  at: string;
  step: string;
  detail: string;
}

// TraceRing keeps hops for the newest `size` traces, each for `ttlMs`.
export class TraceRing {
  private items = new Map<string, { born: number; hops: Hop[] }>();
  private size: number;
  private ttlMs: number;
  constructor(size = 200, ttlMs = 3600_000) {
    this.size = size;
    this.ttlMs = ttlMs;
  }

  add(trace: string, step: string, detail: string, now = Date.now()): void {
    this.prune(now);
    let item = this.items.get(trace);
    if (!item) {
      item = { born: now, hops: [] };
      this.items.set(trace, item);
      while (this.items.size > this.size) this.items.delete(this.items.keys().next().value!);
    }
    if (item.hops.length < 50) item.hops.push({ at: new Date(now).toISOString(), step, detail: detail.slice(0, 300) });
  }

  get(trace: string, now = Date.now()) {
    this.prune(now);
    const item = this.items.get(trace);
    return { trace, found: !!item, hops: item ? item.hops : [] };
  }

  private prune(now: number) {
    for (const [k, v] of this.items) {
      if (now - v.born <= this.ttlMs) break;
      this.items.delete(k);
    }
  }
}

// RateLimit allows `max` events per `windowMs` for each key.
export class RateLimit {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(key = "", now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    while (this.hits.size > 10000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}

export function traceResponse(req: Request, ring: TraceRing, id: string): Response {
  if (!TRACE_RE.test(id)) return json(req, 400, { error: "bad trace id" });
  return json(req, 200, ring.get(id));
}

const chainLimit = new RateLimit(10, 60_000);

// startChain validates {"trace": "<uuid>"}, applies 10 starts a minute, and runs fn in the background.
export async function startChain(req: Request, fn: (trace: string) => Promise<void>, limit = chainLimit): Promise<Response> {
  let trace: unknown;
  try {
    trace = JSON.parse(new TextDecoder().decode(await readCapped(req.body, 4096))).trace;
  } catch {
    return json(req, 400, { error: "body must be JSON {\"trace\": \"<uuid>\"}" });
  }
  if (typeof trace !== "string" || !TRACE_RE.test(trace)) return json(req, 400, { error: "bad trace id" });
  if (!limit.allow()) return json(req, 429, { error: "rate limited" });
  fn(trace).catch((e) => console.error(`chain ${trace} failed:`, (e as Error).message));
  return json(req, 202, { trace, started: true });
}
