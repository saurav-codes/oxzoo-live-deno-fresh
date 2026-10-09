import { test } from "node:test";
import assert from "node:assert/strict";
import { corsHeaders, fp, preflight, RateLimit, serverLabel, sha256hex, signature, signHeader, startChain, TRACE_RE, TraceRing, verifySignature, withProbeLock } from "../lib/zoo.ts";

const KEY = "zoo-test-key-0123456789abcdef";
const T = 1760000000;

test("zoo-sig v1 test vectors", () => {
  assert.equal(sha256hex('{"sku":"ZOO-1"}'), "cc2860a77ea231854ea58f9cb05f3217059f80a8e95d7b69a204293ae4f3a444");
  assert.equal(signature(KEY, T, "POST", "/api/items?x=1", '{"sku":"ZOO-1"}'), "50c22839fe6a06cb51a9fd25167d9e457eb0b5ee63ce696f4c5428a6b9271da1");
  assert.equal(signature(KEY, T, "get", "/_zoo/verify", ""), "9a404bebaa32497c5ed39ef8990e8466428f8023d6aa9f5acc94f16fb7670ecb");
  assert.equal(fp(KEY), "915a");
});

test("verifySignature reasons", () => {
  const h = signHeader(KEY, "mesh-shop", "GET", "/_zoo/verify", "", T);
  assert.deepEqual(verifySignature(h, KEY, ["mesh-shop"], "GET", "/_zoo/verify", "", T + 300), { ok: true, caller: "mesh-shop" });
  assert.deepEqual(verifySignature(null, KEY, ["mesh-shop"], "GET", "/_zoo/verify", "", T), { ok: false, error: "missing signature" });
  assert.deepEqual(verifySignature("t=1,sig=zz", KEY, ["mesh-shop"], "GET", "/_zoo/verify", "", T), { ok: false, error: "bad format" });
  assert.deepEqual(verifySignature(h, KEY, ["mesh-shop"], "GET", "/_zoo/verify", "", T + 301), { ok: false, error: "expired" });
  assert.deepEqual(verifySignature(h, KEY, ["other"], "GET", "/_zoo/verify", "", T), { ok: false, error: "unknown caller" });
  assert.deepEqual(verifySignature(h, KEY, ["mesh-shop"], "GET", "/_zoo/verify?x=1", "", T), { ok: false, error: "bad signature" });
  assert.deepEqual(verifySignature(h, "other-key", ["mesh-shop"], "GET", "/_zoo/verify", "", T), { ok: false, error: "bad signature" });
});

test("server label from PUBLIC_HOST", () => {
  assert.equal(serverLabel("catalog-api.s2.zoo.sorv.dev"), "s2");
  assert.equal(serverLabel("localhost"), "local");
  assert.equal(serverLabel(""), "local");
});

test("CORS only for listed origins", () => {
  process.env.ZOO_PANEL_ORIGIN = "https://zoo-control.s1.zoo.sorv.dev, http://localhost:5173";
  const listed = new Request("http://x/_zoo/health", { headers: { origin: "http://localhost:5173" } });
  assert.deepEqual(corsHeaders(listed), { "Access-Control-Allow-Origin": "http://localhost:5173", Vary: "Origin" });
  assert.deepEqual(corsHeaders(new Request("http://x/", { headers: { origin: "https://evil.example" } })), {});
  assert.deepEqual(corsHeaders(new Request("http://x/")), {});
  const pre = preflight(listed);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(pre.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(pre.headers.get("access-control-max-age"), "600");
  assert.notEqual(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const bad = preflight(new Request("http://x/", { headers: { origin: "https://evil.example" } }));
  assert.equal(bad.status, 204);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("trace id validation", () => {
  assert.ok(TRACE_RE.test("0f8fad5b-d9cb-469f-a165-70867728950e"));
  assert.ok(!TRACE_RE.test("0F8FAD5B-D9CB-469F-A165-70867728950E"));
  assert.ok(!TRACE_RE.test("0f8fad5b-d9cb-469f-a165-70867728950e\n"));
  assert.ok(!TRACE_RE.test("../etc/passwd"));
});

test("trace ring keeps 200 entries for 1 h", () => {
  const ring = new TraceRing();
  const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
  for (let i = 0; i < 201; i++) ring.add(id(i), "step", "d", 1000);
  assert.equal(ring.get(id(0), 1000).found, false);
  assert.equal(ring.get(id(200), 1000).hops[0].step, "step");
  assert.deepEqual(ring.get(id(200), 1000 + 3600_001), { trace: id(200), found: false, hops: [] });
});

test("rate limit and chain start", async () => {
  const rl = new RateLimit(10, 60_000);
  for (let i = 0; i < 10; i++) assert.ok(rl.allow("a", 0));
  assert.ok(!rl.allow("a", 1));
  assert.ok(rl.allow("a", 60_001));
  const lim = new RateLimit(1, 60_000);
  const post = (body: string) => new Request("http://x/_zoo/chain/c", { method: "POST", body });
  let ran = "";
  const ok = await startChain(post('{"trace":"0f8fad5b-d9cb-469f-a165-70867728950e"}'), async (t) => void (ran = t), lim);
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { trace: "0f8fad5b-d9cb-469f-a165-70867728950e", started: true });
  assert.equal(ran, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal((await startChain(post('{"trace":"nope"}'), async () => {}, lim)).status, 400);
  assert.equal((await startChain(post("x".repeat(5000)), async () => {}, lim)).status, 400);
  assert.equal((await startChain(post('{"trace":"0f8fad5b-d9cb-469f-a165-70867728950e"}'), async () => {}, lim)).status, 429);
});

test("probe lock: second caller gets null after waiting", async () => {
  let release!: () => void;
  const first = withProbeLock(() => new Promise<string>((r) => (release = () => r("first"))));
  const second = await withProbeLock(async () => "second", 50);
  assert.equal(second, null);
  release();
  assert.equal(await first, "first");
  assert.equal(await withProbeLock(async () => "third", 50), "third");
});
