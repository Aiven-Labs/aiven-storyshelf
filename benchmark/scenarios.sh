#!/usr/bin/env bash
# The comparison: N builds captured at once, locally against a remote Playwright server.
#   benchmark/scenarios.sh            (BUILDS=3 by default; set BUILDS=1 for the single-build baseline)
set -eo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
N=${BUILDS:-3}
export BUILDS=$N

# 1. Local Chromium on a 2 vCPU / 4GB app host.
APP_CPUS=2 APP_MEM=4g "$HERE/run.sh" local "local-2cpu-${N}builds"
# 2. Remote: 1 vCPU / 1GB app host plus one 2 vCPU / 4GB Playwright server (3 vCPU in total).
APP_CPUS=1 APP_MEM=1g SERVER_CPUS=2 SERVER_MEM=4g "$HERE/run.sh" remote "remote-1app-2server-${N}builds"
# 3. Local with the same total CPU as scenario 2 (3 vCPU / 5GB), for a like-for-like comparison.
APP_CPUS=3 APP_MEM=5g "$HERE/run.sh" local "local-3cpu-${N}builds"
