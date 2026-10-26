#!/usr/bin/env python3
"""Helpers for run.sh. Standard library only.

  bench.py sample --out F --stop F [--interval 3] NAME=CONTAINER ...
  bench.py probe  --base URL --cookies JAR --out F --stop F --phase NAME [--slug S --build ID]
  bench.py wait   --base URL --out F [--since EPOCH] SLUG=TOKEN ...
  bench.py report --dir RUN_DIR
"""
import argparse
import collections
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request


def unit_mib(text):
    value = text.strip()
    for suffix, factor in (("GiB", 1024), ("MiB", 1), ("KiB", 1 / 1024), ("B", 1 / 1048576)):
        if value.endswith(suffix):
            return float(value[: -len(suffix)]) * factor
    return 0.0


def cmd_sample(args):
    pairs = [p.split("=", 1) for p in args.targets]
    names = {cid: name for name, cid in pairs}
    ids = list(names)
    while not os.path.exists(args.stop):
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.ID}}|{{.MemUsage}}|{{.CPUPerc}}|{{.NetIO}}", *ids],
            capture_output=True, text=True,
        ).stdout
        now = time.time()
        with open(args.out, "a") as fh:
            for line in out.strip().splitlines():
                cid, mem, cpu, net = (line.split("|") + ["", "", "", ""])[:4]
                name = next((n for c, n in names.items() if c.startswith(cid) or cid.startswith(c[:12])), cid)
                try:
                    fh.write(json.dumps({"t": now, "name": name, "mem_mib": unit_mib(mem.split("/")[0]),
                                         "cpu": float(cpu.strip().rstrip("%")), "net": net.strip()}) + "\n")
                except ValueError:
                    pass
        time.sleep(args.interval)


def cookie_header(jar):
    cookies = []
    for line in open(jar):
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line:
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            cookies.append(f"{parts[5]}={parts[6]}")
    return "; ".join(cookies)


def cmd_probe(args):
    cookie = cookie_header(args.cookies)
    endpoints = {"health API": "/api/v1/health", "projects page": "/projects"}
    if args.slug and args.build:
        endpoints["build details page"] = f"/projects/{args.slug}/builds/{args.build}"
        endpoints["storybook iframe.html"] = f"/projects/{args.slug}/storybook/build/{args.build}/iframe.html"
        endpoints["storybook index.json"] = f"/projects/{args.slug}/storybook/build/{args.build}/index.json"
    while not os.path.exists(args.stop):
        for name, path in endpoints.items():
            request = urllib.request.Request(args.base + path, headers={"Cookie": cookie})
            started = time.perf_counter()
            status = 0
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    response.read()
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            except Exception:
                status = 0
            elapsed = (time.perf_counter() - started) * 1000
            with open(args.out, "a") as fh:
                fh.write(json.dumps({"phase": args.phase, "name": name, "ms": elapsed, "status": status}) + "\n")
        time.sleep(1.5)


def api(base, path, token):
    request = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def cmd_wait(args):
    pending = dict(p.split("=", 1) for p in args.targets)
    started = args.since or time.time()
    done = {}
    while pending and time.time() - started < 6 * 3600:
        for slug, token in list(pending.items()):
            try:
                builds = api(args.base, f"/api/v1/projects/{slug}/builds", token)
                builds = builds.get("builds", builds) if isinstance(builds, dict) else builds
                build = builds[0]
            except Exception:
                continue
            if build["status"] not in ("pending", "capturing", "comparing"):
                done[slug] = {"status": build["status"], "snapshots": build["snapshotCount"],
                              "seconds": round(time.time() - started), "build": build["id"]}
                del pending[slug]
        time.sleep(5)
    for slug in pending:
        done[slug] = {"status": "timeout", "snapshots": 0, "seconds": round(time.time() - started), "build": None}
    json.dump(done, open(args.out, "w"), indent=2)


def percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * fraction))]


def cmd_report(args):
    run = args.dir
    meta = json.load(open(f"{run}/meta.json"))
    waited = json.load(open(f"{run}/wait.json"))
    lines = [f"# Benchmark: {meta['label']}", ""]
    lines += [f"- Date: {meta['date']}", f"- Commit: `{meta['commit']}`", f"- Mode: **{meta['mode']}**",
              f"- Builds at once: {meta['builds']}   Pages at once: {meta['pages']}",
              f"- App host: {meta['app_cpus']} vCPU / {meta['app_mem']}"
              + (f"   Playwright server: {meta['server_cpus']} vCPU / {meta['server_mem']}" if meta["mode"] == "remote" else ""),
              f"- Storybook: `{meta['storybook']}` ({meta.get('stories', '?')} stories)", ""]
    seconds = [b["seconds"] for b in waited.values()]
    lines += ["## Builds", "", "| Project | Status | Snapshots | Finished after |", "|---|---|---|---|"]
    for slug, b in sorted(waited.items()):
        lines.append(f"| {slug} | {b['status']} | {b['snapshots']} | {b['seconds']}s |")
    lines += ["", f"**Time until all builds finished: {max(seconds)}s** (fastest {min(seconds)}s). "
              f"Render failures: {meta.get('failures', '?')}. OOM-killed: {meta.get('oom', '?')}.", ""]

    stats = collections.defaultdict(list)
    last_net = {}
    if os.path.exists(f"{run}/stats.jsonl"):
        for line in open(f"{run}/stats.jsonl"):
            row = json.loads(line)
            stats[row["name"]].append(row)
            last_net[row["name"]] = row["net"]
    if stats:
        lines += ["## Resources", "", "| Container | Peak memory | Avg CPU | Peak CPU | Network (in / out) |", "|---|---|---|---|---|"]
        for name, rows in sorted(stats.items()):
            cpu = [r["cpu"] for r in rows]
            lines.append(f"| {name} | {round(max(r['mem_mib'] for r in rows))} MiB | {round(sum(cpu) / len(cpu))}% | "
                         f"{round(max(cpu))}% | {last_net[name]} |")
        lines.append("")

    probes = collections.defaultdict(lambda: collections.defaultdict(list))
    errors = collections.defaultdict(lambda: collections.defaultdict(int))
    if os.path.exists(f"{run}/probe.jsonl"):
        for line in open(f"{run}/probe.jsonl"):
            row = json.loads(line)
            if row["status"] == 200:
                probes[row["name"]][row["phase"]].append(row["ms"])
            else:
                errors[row["name"]][row["phase"]] += 1
    if probes:
        lines += ["## Responsiveness (single client; idle vs while the builds capture)", "",
                  "| Page | Idle median | Loaded median | Loaded p95 | Loaded max | Errors while loaded |", "|---|---|---|---|---|---|"]
        for name, phases in probes.items():
            idle, loaded = phases.get("idle", []), phases.get("loaded", [])
            fmt = lambda values, f: f"{round(f(values))} ms" if values else "n/a"
            lines.append(f"| {name} | {fmt(idle, statistics.median)} | {fmt(loaded, statistics.median)} | "
                         f"{fmt(loaded, lambda v: percentile(v, 0.95))} | {fmt(loaded, max)} | {errors[name].get('loaded', 0)} |")
        lines.append("")
    print("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("sample"); p.add_argument("--out", required=True); p.add_argument("--stop", required=True)
    p.add_argument("--interval", type=float, default=3); p.add_argument("targets", nargs="+"); p.set_defaults(fn=cmd_sample)
    p = sub.add_parser("probe"); p.add_argument("--base", required=True); p.add_argument("--cookies", required=True)
    p.add_argument("--out", required=True); p.add_argument("--stop", required=True); p.add_argument("--phase", required=True)
    p.add_argument("--slug"); p.add_argument("--build"); p.set_defaults(fn=cmd_probe)
    p = sub.add_parser("wait"); p.add_argument("--base", required=True); p.add_argument("--out", required=True); p.add_argument("--since", type=float)
    p.add_argument("targets", nargs="+"); p.set_defaults(fn=cmd_wait)
    p = sub.add_parser("report"); p.add_argument("--dir", required=True); p.set_defaults(fn=cmd_report)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
