#!/usr/bin/env bash
# ─── Tao — Latency Benchmark ───
# Measures keystroke-to-echo latency: PTY → parser → output.
# Usage: bash bench/latency-bench.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNS=${1:-100}
BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Terminal Input Latency Benchmark          ║${NC}"
echo -e "${BOLD}║   (PTY → parser → output, ${RUNS} samples)       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${BOLD}─── Tao (taod Zig daemon) ───${NC}"
echo -ne "  Measuring... "
npx tsx "$SCRIPT_DIR/latency-taod.ts" "$RUNS" 2>/dev/null

echo ""
echo -e "${BOLD}─── VT Parser Comparison (WASM vs JS) ───${NC}"
echo -ne "  Measuring... "
npx tsx "$SCRIPT_DIR/benchmark.ts" 2>/dev/null
echo ""
echo -e "${GREEN}${BOLD}Done.${NC}"
echo ""
echo -e "Note: taod benchmark measures full pipeline (write → socket → daemon →"
echo -e "PTY → echo → daemon → binary stream). WASM benchmark from bench/benchmark.ts."
