#!/usr/bin/env bash
# Run one benchmark: upload several Storybook builds at the same time and measure how long they take, what the
# containers use, and how responsive the app stays meanwhile.
#
#   benchmark/run.sh <local|remote> [label]
#
# Settings come from the environment or benchmark/.env (see .env.example). The report is written to
# benchmark/results/<timestamp>-<label>.md; raw data stays in benchmark/results/<timestamp>-<label>/.
# KEEP=1 leaves the stack running afterwards.
set -eo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
MODE=${1:?usage: run.sh <local|remote> [label]}
LABEL=${2:-$MODE}
case "$MODE" in local|remote) ;; *) echo "mode must be local or remote" >&2; exit 2 ;; esac

# Load benchmark/.env without overriding variables already set in the environment.
if [ -f "$HERE/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    [ -z "${!key+x}" ] && export "$key=$value"
  done < "$HERE/.env"
fi
if [ "$MODE" = local ]; then export APP_CPUS=${APP_CPUS:-2} APP_MEM=${APP_MEM:-4g}; else export APP_CPUS=${APP_CPUS:-1} APP_MEM=${APP_MEM:-1g}; fi
export SERVER_CPUS=${SERVER_CPUS:-2} SERVER_MEM=${SERVER_MEM:-4g} PAGES=${PAGES:-4} BUILDS=${BUILDS:-3}
export APP_PORT=${APP_PORT:-3000}
STORYBOOK_DIR=${STORYBOOK_DIR:-../design-system/storybook-static}

if docker compose version >/dev/null 2>&1; then DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then DC=(docker-compose)
else echo "Docker Compose is required (docker compose or docker-compose)." >&2; exit 1; fi
DC+=(-f "$HERE/compose.yaml" --profile "$MODE")

SB=$(cd "$ROOT" && cd "$STORYBOOK_DIR" && pwd) || { echo "Storybook build not found: $STORYBOOK_DIR" >&2; exit 1; }
BASE=http://localhost:$APP_PORT
RUN_ID=$(date +%Y%m%d-%H%M%S)-$LABEL
OUT=$HERE/results/$RUN_ID
mkdir -p "$OUT"
JAR=$OUT/cookies.txt
HDR=(-H 'content-type: application/json' -H "origin: $BASE")

cleanup() {
  touch "$OUT/stop" "$OUT/idle-stop"
  jobs -p | xargs kill 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] || "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== $LABEL ($MODE): $BUILDS builds, $APP_CPUS vCPU / $APP_MEM app, pages $PAGES"
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${DC[@]}" up -d --build

echo "== waiting for the app"
for _ in $(seq 1 90); do curl -sf "$BASE/api/v1/health" >/dev/null && break; sleep 2; done
curl -sf "$BASE/api/v1/health" >/dev/null || { echo "app did not start" >&2; "${DC[@]}" logs app-$MODE | tail -30; exit 1; }

# Sign in as the admin and create one project per build, each with its own CI token.
curl -s -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" "${HDR[@]}" \
  -d '{"email":"admin@example.com","password":"test-admin-password-123"}' -o /dev/null
PAIRS=()
for i in $(seq 1 "$BUILDS"); do
  slug=bench-$i
  curl -s -b "$JAR" -X POST "$BASE/api/v1/projects" "${HDR[@]}" -d "{\"name\":\"$slug\",\"slug\":\"$slug\"}" -o /dev/null
  # Remote projects must render on the Playwright server's target; local ones keep the default `chromium`.
  if [ "$MODE" = remote ]; then
    curl -s -b "$JAR" -X PATCH "$BASE/api/v1/projects/$slug" "${HDR[@]}" -d '{"browser":"chromium@grid"}' -o /dev/null
  fi
  token=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/projects/$slug/tokens" "${HDR[@]}" -d '{"name":"ci"}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  PAIRS+=("$slug=$token")
done

APP_ID=$("${DC[@]}" ps -q "app-$MODE")
TARGETS=("app=$APP_ID")
if [ "$MODE" = remote ]; then TARGETS+=("server=$("${DC[@]}" ps -q playwright)"); fi
python3 "$HERE/lib/bench.py" sample --out "$OUT/stats.jsonl" --stop "$OUT/stop" "${TARGETS[@]}" &

echo "== idle responsiveness (10s)"
python3 "$HERE/lib/bench.py" probe --base "$BASE" --cookies "$JAR" --out "$OUT/probe.jsonl" --stop "$OUT/idle-stop" --phase idle --slug bench-1 &
IDLE_PID=$!
sleep 10; touch "$OUT/idle-stop"; wait "$IDLE_PID" 2>/dev/null || true

echo "== uploading $BUILDS builds at once"
START=$(python3 -c 'import time;print(time.time())')
UPLOADS=()
for i in $(seq 1 "$BUILDS"); do
  token=${PAIRS[$((i-1))]#*=}
  ( cd "$(dirname "$SB")" && npx -y storyshelf@0.7.0 upload --url "$BASE" --slug "bench-$i" --token "$token" \
      --sha "bench-$i" --branch main --build-dir "$SB" > "$OUT/upload-$i.log" 2>&1 ) &
  UPLOADS+=($!)
done
for pid in "${UPLOADS[@]}"; do wait "$pid" || echo "an upload failed; see $OUT/upload-*.log"; done

# Probe the first build's pages while every build is capturing.
FIRST_TOKEN=${PAIRS[0]#*=}
BUILD_ID=$(curl -s -H "authorization: Bearer $FIRST_TOKEN" "$BASE/api/v1/projects/bench-1/builds" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("builds",d) if isinstance(d,dict) else d;print(d[0]["id"])')
python3 "$HERE/lib/bench.py" probe --base "$BASE" --cookies "$JAR" --out "$OUT/probe.jsonl" --stop "$OUT/stop" --phase loaded \
  --slug bench-1 --build "$BUILD_ID" &

echo "== waiting for the builds to finish"
python3 "$HERE/lib/bench.py" wait --base "$BASE" --out "$OUT/wait.json" --since "$START" "${PAIRS[@]}"
touch "$OUT/stop"; sleep 4

FAILURES=$("${DC[@]}" logs "app-$MODE" 2>/dev/null | grep -c '"msg":"render failed' || true)
OOM=$(docker inspect -f '{{.State.OOMKilled}}' "$APP_ID")
STORIES=$(python3 -c "import json;print(sum(1 for e in json.load(open('$SB/index.json'))['entries'].values() if e['type']=='story'))" 2>/dev/null || echo '?')
python3 - "$OUT/meta.json" <<PY
import json,subprocess,sys,datetime
commit=subprocess.run(["git","-C","$ROOT","rev-parse","--short","HEAD"],capture_output=True,text=True).stdout.strip()
json.dump({"label":"$LABEL","mode":"$MODE","date":datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),"commit":commit,
 "builds":$BUILDS,"pages":$PAGES,"app_cpus":"$APP_CPUS","app_mem":"$APP_MEM",
 "server_cpus":"$SERVER_CPUS","server_mem":"$SERVER_MEM","storybook":"$STORYBOOK_DIR","stories":"$STORIES",
 "failures":"$FAILURES","oom":"$OOM"},open(sys.argv[1],"w"),indent=2)
PY
python3 "$HERE/lib/bench.py" report --dir "$OUT" | tee "$HERE/results/$RUN_ID.md"
echo "== report: benchmark/results/$RUN_ID.md"
