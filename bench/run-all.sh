#!/usr/bin/env bash
# ─── Tau — Master Benchmark Runner ───
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
echo -e "${BOLD}║            Tau — Complete Benchmark Suite               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# 1. Parser benchmark (Node.js, headless)
echo -e "${CYAN}▶ Bench 1/4: VT Parser Throughput${NC}"
pnpm bench || echo "  (parser benchmark completed with warnings)"

# 2. Latency benchmark
echo ""
echo -e "${CYAN}▶ Bench 2/4: Input Latency${NC}"
bash "$SCRIPT_DIR/latency-bench.sh" || echo "  (latency benchmark skipped)"

# 3. Cross-terminal throughput
echo ""
echo -e "${CYAN}▶ Bench 3/4: Cross-Terminal Throughput${NC}"
bash "$SCRIPT_DIR/cross-terminal.sh" || echo "  (cross-terminal benchmark skipped)"

# 4. Startup time
echo ""
echo -e "${CYAN}▶ Bench 4/4: Startup Time${NC}"
bash "$SCRIPT_DIR/startup-bench.sh" || echo "  (startup benchmark skipped)"

echo ""
echo -e "${GREEN}${BOLD}All benchmarks complete.${NC}"
echo ""
echo "Results:"
echo "  bench/results.txt          — cross-terminal throughput"
echo "  bench/startup-results.txt  — startup time"
echo "  (parser + latency results printed to stdout above)"
