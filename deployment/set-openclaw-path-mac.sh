#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC_FILE="${HOME}/.zshrc"

printf '\nexport PATH="%s/bin:$PATH"\n' "${SCRIPT_DIR}" >> "${RC_FILE}"

echo "[ok] appended PATH to ${RC_FILE}"
echo "[hint] run: source ${RC_FILE}"
