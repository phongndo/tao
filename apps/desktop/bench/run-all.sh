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
echo -e "${CYAN}▶ Bench 1/6: taod daemon vs node-pty${NC}"
bash "$SCRIPT_DIR/taod-vs-node-pty.sh" || echo "  (taod benchmark skipped)"

# 2. Latency benchmark (via taod)
echo ""
echo -e "${CYAN}▶ Bench 2/6: Input Latency (taod)${NC}"
npx tsx "$SCRIPT_DIR/latency-taod.ts" || echo "  (latency benchmark skipped)"

# 3. VT Parser benchmark (Node.js, headless)
echo ""
echo -e "${CYAN}▶ Bench 3/6: VT Parser Throughput${NC}"
npx tsx "$SCRIPT_DIR/benchmark.ts" || echo "  (parser benchmark skipped)"

# 4. Cross-terminal throughput
echo ""
echo -e "${CYAN}▶ Bench 4/6: Cross-Terminal Throughput${NC}"
bash "$SCRIPT_DIR/cross-terminal.sh" || echo "  (cross-terminal benchmark skipped)"

# 5. Startup time
echo ""
echo -e "${CYAN}▶ Bench 5/6: Startup Time${NC}"
bash "$SCRIPT_DIR/startup-bench.sh" || echo "  (startup benchmark skipped)"

# 6. Electron IPC transport
echo ""
echo -e "${CYAN}▶ Bench 6/6: Electron IPC Transport${NC}"
npx tsx "$SCRIPT_DIR/run-electron.ts" "$SCRIPT_DIR/ipc-benchmark.ts" || echo "  (IPC benchmark skipped)"

echo ""
echo -e "${GREEN}${BOLD}All benchmarks complete.${NC}"
echo ""
echo "Results:"
echo "  bench/results.txt          — cross-terminal throughput"
echo "  bench/startup-results.txt  — startup time"
echo "  (parser + latency + IPC results printed to stdout above)"
