# Benchmark: remote-1app-2server-3builds

- Date: 2026-10-26 21:24
- Commit: `04aaa3e`
- Mode: **remote**
- Builds at once: 3   Pages at once: 4
- App host: 1 vCPU / 1g   Playwright server: 2 vCPU / 4g
- Storybook: `../design-system/storybook-static` (556 stories)

## Builds

| Project | Status | Snapshots | Finished after |
|---|---|---|---|
| bench-1 | approved | 556 | 1041s |
| bench-2 | approved | 556 | 1041s |
| bench-3 | approved | 556 | 1041s |

**Time until all builds finished: 1041s** (fastest 1041s). Render failures: 0. OOM-killed: false.

## Resources

| Container | Peak memory | Avg CPU | Peak CPU | Network (in / out) |
|---|---|---|---|---|
| app | 452 MiB | 39% | 101% | 1.06GB / 5.23GB |
| server | 1644 MiB | 164% | 207% | 4.76GB / 475MB |

## Responsiveness (single client; idle vs while the builds capture)

| Page | Idle median | Loaded median | Loaded p95 | Loaded max | Errors while loaded |
|---|---|---|---|---|---|
| health API | 19 ms | 8 ms | 22 ms | 724 ms | 0 |
| projects page | 19 ms | 15 ms | 30 ms | 1587 ms | 0 |
| build details page | n/a | 34 ms | 75 ms | 504 ms | 0 |
| storybook iframe.html | n/a | 25 ms | 38 ms | 165 ms | 0 |
| storybook index.json | n/a | 25 ms | 36 ms | 65 ms | 0 |

