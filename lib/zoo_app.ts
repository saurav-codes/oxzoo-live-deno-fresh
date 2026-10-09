// The zoo endpoints, registered on the Fresh app as native routes.
import type { App } from "fresh";
import { type AppInfo, type CheckSpec, env, health, json, preflight, probe, readJSON, variable } from "./zoo.ts";

declare const __BUILT_AT__: string;

export const info: AppInfo = {
  name: "deno-fresh",
  stack: "Deno Fresh 2",
  build: { built_at: typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : undefined },
};

const memory = new Map<string, string>();

const checks: CheckSpec[] = [
  {
    id: "memory",
    label: "In-memory write, read, delete",
    env: [],
    run() {
      const key = `probe:${crypto.randomUUID()}`;
      const value = crypto.randomUUID();
      memory.set(key, value);
      const back = memory.get(key);
      memory.delete(key);
      if (back !== value) throw new Error("read back a different value");
      if (memory.has(key)) throw new Error("delete left the entry behind");
      return Promise.resolve(`Map round trip, ${memory.size} entries left`);
    },
  },
  {
    id: "self",
    label: "Own health over loopback",
    env: ["PORT"],
    async run(ctx) {
      const res = await fetch(`http://127.0.0.1:${env("PORT")}/_zoo/health`, { signal: ctx.signal });
      const body = await readJSON(res);
      if (res.status !== 200 || body.name !== info.name) throw new Error(`status ${res.status}, name ${JSON.stringify(body.name)}`);
      return `GET 127.0.0.1:$PORT/_zoo/health answered ${body.name}, uptime ${body.uptime_s} s`;
    },
  },
];

// deno-lint-ignore no-explicit-any
export function zooRoutes(app: App<any>) {
  app.route("/_zoo/health", {
    handler: {
      GET: (ctx) => json(ctx.req, 200, health(info)),
      OPTIONS: (ctx) => preflight(ctx.req),
    },
  });
  app.route("/_zoo/probe", {
    handler: {
      GET: (ctx) => probe(ctx.req, info, checks, [variable("ZOO_PANEL_ORIGIN", "plain", { show: true })]),
      OPTIONS: (ctx) => preflight(ctx.req),
    },
  });
  return app;
}
