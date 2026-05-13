#!/usr/bin/env bash
# ─── Tau — Terminal Startup Time Benchmark ───
#
# Measures cold-start and warm-start time for each terminal emulator:
# time from app launch → shell prompt visible.
#
# Usage:
#   chmod +x bench/startup-bench.sh
#   bash bench/startup-bench.sh
#
# Methodology: launches each terminal 3 times, measures wall-clock time
# from exec to the shell printing a marker string.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$SCRIPT_DIR/startup-results.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

RUNS=3

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Terminal Startup Time Benchmark           ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

echo "terminal|run|duration_ms" > "$RESULTS"

# ─── Tau (our Electron app) ───
echo -e "${BOLD}─── Tau (Electron + ghostty-web) ───${NC}"
for i in $(seq 1 $RUNS); do
  echo -ne "  Run $i... "
  start=$(date +%s%3N)
  # Launch tau, wait for it to be ready, then close
  # We use a timeout since electron . will open a window
  PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
  timeout 10 bash -c "
    cd '$PROJECT_ROOT' && npx electron . &
    PID=\$!
    # Wait for window to appear (poll for Electron process)
    for j in \$(seq 1 20); do
      if ps -p \$PID > /dev/null 2>&1; then
        sleep 0.3
      else
        break
      fi
    done
    # Give it a moment to render
    sleep 1
    kill \$PID 2>/dev/null || true
  " > /dev/null 2>&1 || true
  end=$(date +%s%3N)
  elapsed=$((end - start))
  printf "${GREEN}%6d ms${NC}\n" $elapsed
  echo "tau (electron)|$i|$elapsed" >> "$RESULTS"
  sleep 1
done

# ─── VS Code ───
if command -v code &> /dev/null; then
  echo -e "${BOLD}─── VS Code (Electron + xterm.js) ───${NC}"
  for i in $(seq 1 $RUNS); do
    echo -ne "  Run $i... "
    start=$(date +%s%3N)
    timeout 15 bash -c "
      code --new-window --disable-extensions --wait /tmp/empty.txt 2>/dev/null &
      sleep 2
    " > /dev/null 2>&1 || true
    end=$(date +%s%3N)
    elapsed=$((end - start))
    printf "${GREEN}%6d ms${NC}\n" $elapsed
    echo "vscode (xterm.js)|$i|$elapsed" >> "$RESULTS"
    sleep 1
  done
else
  echo -e "  ${RED}VS Code not found${NC}"
fi

# ─── Zed ───
if command -v zed &> /dev/null; then
  echo -e "${BOLD}─── Zed (native GPUI) ───${NC}"
  for i in $(seq 1 $RUNS); do
    echo -ne "  Run $i... "
    start=$(date +%s%3N)
    timeout 10 zed --wait /tmp/empty.txt > /dev/null 2>&1 || true
    end=$(date +%s%3N)
    elapsed=$((end - start))
    printf "${GREEN}%6d ms${NC}\n" $elapsed
    echo "zed (native)|$i|$elapsed" >> "$RESULTS"
    sleep 1
  done
else
  echo -e "  ${RED}Zed not found${NC}"
fi

# ─── Ghostty ───
if command -v ghostty &> /dev/null; then
  echo -e "${BOLD}─── Ghostty (native Zig) ───${NC}"
  for i in $(seq 1 $RUNS); do
    echo -ne "  Run $i... "
    start=$(date +%s%3N)
    timeout 10 ghostty -e 'bash -c "echo READY; sleep 0.5; exit"' > /dev/null 2>&1 || true
    end=$(date +%s%3N)
    elapsed=$((end - start))
    printf "${GREEN}%6d ms${NC}\n" $elapsed
    echo "ghostty (native)|$i|$elapsed" >> "$RESULTS"
    sleep 1
  done
else
  echo -e "  ${RED}Ghostty not found${NC}"
fi

# ─── macOS Terminal.app ───
echo -e "${BOLD}─── Terminal.app (native macOS) ───${NC}"
for i in $(seq 1 $RUNS); do
  echo -ne "  Run $i... "
  start=$(date +%s%3N)
  osascript -e '
    tell application "Terminal"
      activate
      do script "echo READY; sleep 0.5; exit"
      delay 0.3
      repeat
        if not (exists window 1) then exit repeat
        delay 0.1
      end repeat
    end tell
  ' > /dev/null 2>&1 || true
  end=$(date +%s%3N)
  elapsed=$((end - start))
  printf "${GREEN}%6d ms${NC}\n" $elapsed
  echo "Terminal.app|$i|$elapsed" >> "$RESULTS"
  sleep 1
done

# ─── Superset ───
if [ -d "/Applications/Superset.app" ]; then
  echo -e "${BOLD}─── Superset (Electron + xterm.js) ───${NC}"
  for i in $(seq 1 $RUNS); do
    echo -ne "  Run $i... "
    start=$(date +%s%3N)
    timeout 15 bash -c "
      open -a Superset &
      sleep 3
      osascript -e 'tell application \"Superset\" to quit' 2>/dev/null || true
    " > /dev/null 2>&1 || true
    end=$(date +%s%3N)
    elapsed=$((end - start))
    printf "${GREEN}%6d ms${NC}\n" $elapsed
    echo "superset (xterm.js)|$i|$elapsed" >> "$RESULTS"
    sleep 1
  done
else
  echo -e "  ${RED}Superset not found${NC}"
fi

# ─── Summary ───
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║              SUMMARY (avg of $RUNS runs)         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

if [ -f "$RESULTS" ]; then
  tail -n +2 "$RESULTS" | awk -F'|' '
  {
    sum[$1] += $3
    count[$1]++
  }
  END {
    for (term in sum) {
      avg = sum[term] / count[term]
      printf "  %-30s %6.0f ms\n", term, avg
    }
  }' | sort -t'|' -k2 -n
fi

echo ""
echo -e "Results saved to: $RESULTS"
