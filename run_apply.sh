#!/bin/bash
# run_apply.sh — Launcher script for the Job Apply Agent
#
# Usage:
#   bash run_apply.sh              # Full run
#   bash run_apply.sh --dry-run   # Dry run (no submissions)
#
# For Linux/macOS cron:
#   0 10 * * 1-5 /path/to/job-apply-agent/run_apply.sh >> /path/to/job-apply-agent/logs/cron.log 2>&1
#
# For Windows via Git Bash (called by run_apply.bat):
#   This script is executed by Git Bash, which is invoked from run_apply.bat

set -euo pipefail

# Set PATH to include common Node.js installation locations
export PATH="/usr/local/bin:/usr/bin:/usr/local/nvm/versions/node/$(node --version 2>/dev/null | tr -d v)/bin:$PATH"

# Get the directory containing this script (so it works from any cwd)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to the project directory
cd "$SCRIPT_DIR"

# Ensure logs directory exists
mkdir -p "$SCRIPT_DIR/logs"

# Log start time
echo "=========================================="
echo " Job Apply Agent starting: $(date)"
echo "=========================================="

# Run the agent, passing through any arguments (e.g., --dry-run)
node index.js "$@" 2>&1

# Log completion
echo "=========================================="
echo " Job Apply Agent completed: $(date)"
echo "=========================================="
