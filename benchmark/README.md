# Parallel capture benchmark

Measures what happens when **several builds are captured at the same time**, with Chromium rendering either
on the app host (`local`) or on a separate Playwright server (`remote`). For each run it records:

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
# One run. Modes: local | remote. The optional second argument names the report.
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
| `PAGES` | 4 | Pages rendered at once across all builds (local: `STORYSHELF_CAPTURE_CONCURRENCY`; remote: Playwright `sessions`). |
| `APP_CPUS` / `APP_MEM` | local 2 / 4g, remote 1 / 1g | Size of the app container. |
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

## Earlier single-build results (this repository's README)

For one build at a time, remote was 10-18% slower than local Chromium on the same CPU, and 34% slower with three
engines.
