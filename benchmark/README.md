# Parallel capture benchmark

Measures what happens when **several builds are captured at the same time**, with Chromium rendering either
on the app host (`local`), on a separate Playwright server (`remote`) or on Azure Playwright Workspaces (`azure`). For each run it records:

- how long until every build finishes, and how long each one takes,
- peak memory, CPU and network of the app (and of the Playwright server in `remote` mode),
- how responsive the app stays while capturing: the health API, the projects page, a build's details page
  and its published Storybook (`iframe.html`, `index.json`), timed by a single client, idle and under load.

Everything runs in Docker through `compose.yaml`; the results land in `results/`.

## Requirements

- Docker with **Compose v2** (`docker compose`) or `docker-compose`.
- Node 24 (the script runs `npx storyshelf upload`) and Python 3.
- A built Storybook to upload (`index.json` + the static files). The default is `../design-system/storybook-static`
  next to this repository; set `STORYBOOK_DIR` (relative to the repository root, or absolute) to use another.
- The images build from this repository: the app (`../Dockerfile`) and the Playwright server
  (`../playwright-server/Dockerfile`, `mcr.microsoft.com/playwright:v1.63.0-noble`, about 3.5GB).

## Run

```sh
# One run. Modes: local | remote | azure. The optional second argument names the report.
benchmark/run.sh local  local-2cpu
APP_CPUS=1 APP_MEM=1g SERVER_CPUS=2 SERVER_MEM=4g benchmark/run.sh remote remote-1app-2server

# The full comparison (about an hour with a 555-story Storybook): local 2 vCPU, remote 1+2 vCPU,
# and local 3 vCPU (same total CPU as the remote run).
benchmark/scenarios.sh
BUILDS=1 benchmark/scenarios.sh      # single-build baseline
```

`KEEP=1` leaves the stack running afterwards so you can look at it (`docker compose -f benchmark/compose.yaml
--profile remote logs app-remote`). Otherwise `down -v` removes the containers and volumes at the end.

## Settings

Set them in the environment or copy `.env.example` to `.env` (the environment wins).

| Variable | Default | Meaning |
|---|---|---|
| `BUILDS` | 3 | Builds uploaded and captured at once (each is its own project, `bench-1`, `bench-2`, ...). |
| `CONNECTIONS` | = `BUILDS` | Renders at once, each on its own connection. With `SHARD_SIZE`, one build can use several. |
| `SHARD_SIZE` | none | Captures per shard (for example 140). Splits a build over several connections. |
| `UPLOAD_ARGS` | none | Extra `storyshelf upload` options, e.g. `--skip '<glob>'` to render fewer stories. |
| `PAGES` | 4 | Pages rendered at once across all builds (local: `STORYSHELF_CAPTURE_CONCURRENCY`; remote: Playwright `sessions`). |
| `APP_CPUS` / `APP_MEM` | local 2 / 4g, remote 1 / 1g, azure 1 / 2g | Size of the app container. |
| `SERVER_CPUS` / `SERVER_MEM` | 2 / 4g | Size of the Playwright server (remote only). |
| `APP_PORT` | 3000 | Host port of the app. |
| `STORYBOOK_DIR` | `../design-system/storybook-static` | Storybook to upload. |

## How it works

1. `compose.yaml` starts Postgres, an S3 mock and either `app-local` or `app-remote` (plus `playwright`), chosen with
   a Compose profile. The app is the repository's server, so these runs use the real code and settings.
2. `run.sh` signs in as the admin, creates one project and CI token per build (remote projects are switched to the
   `chromium@grid` target), starts a stats sampler, probes the app for 10 seconds while idle, then uploads all builds
   in parallel and keeps probing while they capture.
3. `lib/bench.py` polls the API until every build is finished, then writes `results/<timestamp>-<label>.md`.

Files: `compose.yaml`, `run.sh`, `scenarios.sh`, `lib/bench.py`. Raw data per run is in `results/<run>/` (ignored by git);
the markdown reports are committed.

## Reading the results

- **Time until all builds finished** is the makespan: with parallel builds this is the number that matters.
- `remote` costs more total CPU (app host plus server) than `local` at the same capture speed, so compare it against
  the equal-CPU local run (`local-3cpu`), not only the 2 vCPU one.
- The probe is one client on the same machine: it shows how much the app slows down, not how many visitors it can serve. The idle baseline only covers the health API and the projects page, because the build pages do not exist until the builds are uploaded.
- Docker Desktop and Colima give containers CPU limits through cgroups, so the numbers depend on the host's real cores.
  Run the scenarios on an otherwise idle machine, and one at a time.
- The S3 mock and a local Postgres are faster than real storage, so absolute times are optimistic.

## Results: 3 builds at once, 556 stories each, Chromium, 4 pages at once

Run 2026-10-26 on a Colima VM (4 vCPU), one run per scenario, commit `04aaa3e`. Full reports are in `results/`.

| | Local, 2 vCPU / 4GB | Remote: app 1 vCPU / 1GB + server 2 vCPU / 4GB | Local, 3 vCPU / 5GB (same total CPU as remote) |
|---|---|---|---|
| **Time until all 3 builds finished** | **906s** | **1,041s** | **598s** |
| App host peak memory / avg CPU | 1,930 MiB / 192% | 452 MiB / 39% | 2,053 MiB / 284% |
| Server peak memory / avg CPU | n/a | 1,644 MiB / 164% | n/a |
| Network app to server | n/a | 5.2GB | n/a |
| Render failures | 0 | 0 | 0 |

Response time of the app while the builds capture (single client, median / p95):

| Page | Idle | Local 2 vCPU | Remote | Local 3 vCPU |
|---|---|---|---|---|
| health API | 25 ms | 137 / 296 ms | 8 / 22 ms | 81 / 176 ms |
| projects page | 22 ms | 289 / 559 ms | 15 / 30 ms | 171 / 339 ms |
| build details page | n/a | 569 / 980 ms | 34 / 75 ms | 311 / 553 ms |
| storybook `iframe.html` | n/a | 271 / 481 ms | 25 / 38 ms | 152 / 288 ms |

What it shows:

- **Capture speed is set by the CPU that renders.** Three builds at once on 2 vCPU took 906s, about 302s per build, which is the same as one build alone (313s). Parallel builds did not cost extra; they share the CPU.
- **Remote was 15% slower than local on the same render CPU** (1,041s against 906s with 2 vCPU rendering), and 74% slower than local with the same *total* CPU (598s), because the app host's CPU sits mostly idle (39%) in the remote setup.
- **The app stays responsive with remote:** median page times were 10 to 20 times lower while capturing, and the app host needed 452 MiB instead of about 2GB. Remote's gain is isolation, not speed.
- Isolation helps whenever a capture runs, not only when several run in parallel: a single local capture already uses all of the app host's CPU.

Caveats: one client on the same machine, an S3 mock and a local Postgres, one run each, and a 4-core VM shared by the scenario containers.

## Azure Playwright Workspaces trial

Goal: find out, on Azure's free trial (the first 100 test minutes), how many billed minutes one full build uses, how
fast it finishes with more parallel pages, and what the app host needs to feed the browsers. Azure bills the sum of
test durations at $0.01 per minute for Linux browsers (West Europe), per second. The browsers run in Azure, and the app
tunnels the Storybook to them through the connection (`exposeNetwork`), so the app needs no public route for this.

**Set up the workspace** (Azure portal)

1. Create a **Playwright Workspaces** resource. Pick **West Europe** (close to an Aiven app in Frankfurt).
2. Enable **access-token authentication** for the workspace (it is off by default). Microsoft recommends Entra ID, but
   StoryShelf's `azurePlaywright` preset sends an access token.
3. Create an access token with a **short expiry** (days, not months). Treat it as a password.
4. On the workspace's *Get Started* page copy the browser endpoint (`wss://<region>.api.playwright.microsoft.com/playwrightworkspaces/<id>/browsers`).

The `@azure/playwright` package is not needed: it only configures Playwright Test. StoryShelf connects directly.

**Run it**

```sh
export PLAYWRIGHT_SERVICE_URL='wss://...'           # the workspace browser endpoint
export PLAYWRIGHT_SERVICE_ACCESS_TOKEN='...'        # keep out of shell history files and git

# 1. Smoke test with few stories (set UPLOAD_ARGS so only about 20-50 stories render): check the connection works.
BUILDS=1 PAGES=4 UPLOAD_ARGS="--skip '<glob that leaves a few stories>'" benchmark/run.sh azure smoke

# 2. One full build, 4 pages in a single browser.
BUILDS=1 PAGES=4 benchmark/run.sh azure full-4pages

# 3. One full build over several browsers: 4 shards on 4 connections, 8 pages in total.
BUILDS=1 PAGES=8 SHARD_SIZE=140 CONNECTIONS=4 benchmark/run.sh azure full-8pages-4conn
# Then 16 pages / 8 connections (SHARD_SIZE=70), and so on, while the app host CPU stays below about 60%.
```

After each run, open the workspace's usage page in the Azure portal and note the **billed test minutes** for that run.
The report holds everything else.

| Run | Pages / connections | Wall time | Billed minutes | Cost at $0.01 | App host avg CPU / peak memory | Network out |
|---|---|---|---|---|---|---|
| full-4pages | 4 / 1 | | | | | |
| full-8pages-4conn | 8 / 4 | | | | | |
| full-16pages-8conn | 16 / 8 | | | | | |

How to read it:

- **Billed minutes about equal to wall time**: Azure meters the connection (session). **About pages times wall time**:
  it meters each page. Either way, more pages should not raise the bill if the work is the same.
- Wall time that stops falling as you add pages means the app host (CPU or network) or the latency to Azure is the limit,
  not Azure's browsers. If the app host's CPU is the limit, a bigger Aiven plan raises the ceiling.
- The 100 free minutes cover only a few full builds. Use `UPLOAD_ARGS` for smaller runs first.

**On Aiven** set these on the app (mark the token as a secret): `PLAYWRIGHT_SERVICE_URL`,
`PLAYWRIGHT_SERVICE_ACCESS_TOKEN`, `PLAYWRIGHT_SESSIONS` (pages in total), and for several browsers `CAPTURE_SHARD_SIZE` and
`CAPTURE_CONCURRENCY` (connections). Set each project's capture target to `chromium@azure`
(`PATCH /api/v1/projects/<slug>` with `{"browser":"chromium@azure"}`); Azure targets have their own baselines.

**Gotchas**

- A rejected token (wrong or expired) marks the `chromium@azure` target **unavailable until the app restarts**, even
  after you fix the variable. Rotate the token, update the env var and redeploy, before the old one expires.
- A 401 from the endpoint is shown as `Cannot launch chromium@azure: ... 401 Unauthorized`. StoryShelf removes the endpoint
  and the token from the message.
- A hung session keeps billing until it ends, so watch the usage page after the first runs.

## Earlier single-build results (this repository's README)

For one build at a time, remote was 10-18% slower than local Chromium on the same CPU, and 34% slower with three
engines.
