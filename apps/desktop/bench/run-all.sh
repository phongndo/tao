#!/usr/bin/env bash
# ─── Tao — Master Benchmark Runner ───
#
# Runs all benchmarks and prints a comparison summary.
#
# Usage: bash bench/run-all.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║            Tao — Complete Benchmark Suite               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# 1. taod daemon benchmark (Zig vs node-pty comparison)
echo -e "${CYAN}▶ Bench 1/7: taod daemon vs node-pty${NC}"
bash "$SCRIPT_DIR/taod-vs-node-pty.sh" || echo "  (taod benchmark skipped)"

# 2. Latency benchmark (via taod)
echo ""
echo -e "${CYAN}▶ Bench 2/7: Input Latency (taod)${NC}"
npx tsx "$SCRIPT_DIR/latency-taod.ts" || echo "  (latency benchmark skipped)"

# 3. VT Parser benchmark (Node.js, headless)
echo ""
echo -e "${CYAN}▶ Bench 3/7: VT Parser Throughput${NC}"
npx tsx "$SCRIPT_DIR/benchmark.ts" || echo "  (parser benchmark skipped)"

# 4. xterm.js renderer path
echo ""
echo -e "${CYAN}▶ Bench 4/7: xterm.js DOM vs WebGL Renderer${NC}"
npx tsx "$SCRIPT_DIR/run-electron.ts" "$SCRIPT_DIR/xterm-webgl-benchmark.ts" || echo "  (renderer benchmark skipped)"

# 5. Cross-terminal throughput
echo ""
echo -e "${CYAN}▶ Bench 5/7: Cross-Terminal Throughput${NC}"
bash "$SCRIPT_DIR/cross-terminal.sh" || echo "  (cross-terminal benchmark skipped)"

# 6. Startup time
echo ""
echo -e "${CYAN}▶ Bench 6/7: Startup Time${NC}"
bash "$SCRIPT_DIR/startup-bench.sh" || echo "  (startup benchmark skipped)"

# 7. Electron IPC transport
echo ""
echo -e "${CYAN}▶ Bench 7/7: Electron IPC Transport${NC}"
npx tsx "$SCRIPT_DIR/run-electron.ts" "$SCRIPT_DIR/ipc-benchmark.ts" || echo "  (IPC benchmark skipped)"

echo ""
echo -e "${GREEN}${BOLD}All benchmarks complete.${NC}"
echo ""
echo "Results:"
echo "  bench/results.txt          — cross-terminal throughput"
echo "  bench/startup-results.txt  — startup time"
echo "  (parser + renderer + latency + IPC results printed to stdout above)"
