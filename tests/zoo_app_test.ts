// The zoo routes on a real Fresh App, served on a random loopback port.
import { assertEquals, assertMatch } from "@std/assert";
import { App } from "fresh";
import { zooRoutes } from "../lib/zoo_app.ts";

Deno.test("health, probe and CORS on the Fresh app", async () => {
  Deno.env.set("ZOO_PANEL_ORIGIN", "http://localhost:5173");
  Deno.env.set("PUBLIC_HOST", "deno-fresh.s3.zoo.sorv.dev");
  const handler = zooRoutes(new App()).handler();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  Deno.env.set("PORT", String(server.addr.port));
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    const h = await fetch(`${base}/_zoo/health`, { headers: { origin: "http://localhost:5173" } });
    assertEquals(h.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const hb = await h.json();
    assertEquals([hb.name, hb.server], ["deno-fresh", "s3"]);

    const p = await (await fetch(`${base}/_zoo/probe`)).json();
    assertEquals(p.ok, true, JSON.stringify(p.checks));
    assertEquals(p.checks.map((c: { id: string }) => c.id), ["memory", "self"]);
    assertMatch(p.checks[1].detail, /answered deno-fresh/);
    assertEquals(p.vars, [{ name: "ZOO_PANEL_ORIGIN", role: "plain", fp: p.vars[0].fp, value: "http://localhost:5173" }]);

    const pre = await fetch(`${base}/_zoo/probe`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    await pre.body?.cancel();
    assertEquals(pre.status, 204);
    assertEquals(pre.headers.get("access-control-max-age"), "600");

    const evil = await fetch(`${base}/_zoo/health`, { headers: { origin: "https://evil.example" } });
    await evil.body?.cancel();
    assertEquals(evil.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("self check fails clearly without PORT", async () => {
  Deno.env.delete("PORT");
  const handler = zooRoutes(new App()).handler();
  const p = await (await handler(new Request("http://x/_zoo/probe"))).json();
  assertEquals(p.ok, false);
  assertEquals(p.checks[1].error, "PORT is not set");
});
