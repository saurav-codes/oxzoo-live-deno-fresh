# deno-fresh

Deployed with [ox](https://deploywithox.com): deploy a repo to your own server with one command, no Docker. [Docs](https://deploywithox.com/docs) · [Guide for this stack](https://deploywithox.com/docs/guides/deno-fresh)

**Live demo:** https://deno-fresh.s3.zoo.sorv.dev

> **Role in the zoo:** project `deno-fresh` of [oxzoo-live](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/README.md#projects), deployed with [ox](https://deploywithox.com) on server s3 at https://deno-fresh.s3.zoo.sorv.dev. The contract it follows is [DESIGN.md](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/DESIGN.md).

Deno Fresh 2 on s3, deployed with zero config. It is the simplest member of the
zoo: no services and no variables of its own besides `ZOO_PANEL_ORIGIN`.

## What it proves

- Proof level P1: ox detects a Fresh 2 project from `deno.json` and `deno.lock`,
  builds it with Vite, and serves it with `deno serve`.
- The page is server-rendered and contains an island (`islands/HealthCheck.tsx`)
  that hydrates in the browser and calls `/_zoo/health` itself.
- The probe runs two real checks: an in-memory write, read and delete, and a
  loopback fetch of its own `/_zoo/health` on `127.0.0.1:$PORT`.

## ox features exercised

- Zero-config Deno detection: `deno install --frozen`, `deno task build`, start
  from the `start` task (`deno serve -A _fresh/server.js`, which ox runs with
  `--host 127.0.0.1 --port $PORT`).
- `deno.lock` committed and installs with `--frozen`.

## Endpoints

| Path | What |
|------|------|
| `GET /` | server-rendered page with the health island |
| `GET /_zoo/health` | contract health with `build.built_at` |
| `GET /_zoo/probe` | `memory` and `self` checks |

The zoo endpoints are Fresh routes registered in `lib/zoo_app.ts` with
`app.route()`, which also answers the `OPTIONS` preflight.

## Variables

| Name | Source | Role in probe |
|------|--------|---------------|
| `PORT`, `HOST`, `PUBLIC_HOST`, `OX_ENV`, `OX_RELEASE` | provided by ox | none |
| `ZOO_PANEL_ORIGIN` | yours, `https://zoo-control.s1.zoo.sorv.dev` | plain |

## Run and test

```sh
deno install --frozen
deno task test      # zoo-sig vectors, verify reasons, CORS, trace ids, ring, rate limit, probe lock, Fresh app routes
deno task build
PORT=8000 deno serve --host 127.0.0.1 --port 8000 -A _fresh/server.js
```

Local result (2026-10-09, Deno 2.9.7): `deno task test` 10 passed; `deno check`
clean; `deno install --frozen` and `deno task build` succeed; the built server
answers health, the probe is `ok: true` for both checks, preflight returns 204,
the page renders with the island boot script.

## ox check

```console
ox check ~/oxzoo-live/deno-fresh (manifest: none)

  app.start                  deno serve --host 127.0.0.1 --port $PORT -A _fresh/server.js detected:deno.json
  build.install              deno install --frozen                                detected:deno.lock
  build.commands[0]          deno task build                                      detected:deno.json
  tools.deno                 2                                                    default

  Provided by ox: PORT, HOST, OX_ENV, OX_PROJECT, OX_RELEASE, OX_DATA_DIR, PUBLIC_URL, PUBLIC_HOST
  Set on the dashboard before the first deploy: ZOO_PANEL_ORIGIN

Ready to deploy.
```
