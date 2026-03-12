#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/bin/runtime"
BIN_DIR="${SCRIPT_DIR}/bin"

cd "${REPO_ROOT}"

echo "[build] compiling current repository..."
pnpm build
echo "[build] building Control UI assets..."
pnpm ui:build

echo "[build] staging runtime into deployment/bin/runtime..."
rm -rf "${RUNTIME_DIR}"

echo "[build] deploying portable runtime (hoisted, no symlinks)..."
pnpm --filter openclaw deploy --prod --legacy \
  --config.node-linker=hoisted \
  --config.link-workspace-packages=false \
  --config.prefer-workspace-packages=false \
  --config.inject-workspace-packages=false \
  "${RUNTIME_DIR}"

if command -v node >/dev/null 2>&1; then
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"
  case "${OS_RAW}" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *)
      OS=""
      ;;
  esac
  case "${ARCH_RAW}" in
    x86_64 | amd64) ARCH="x86_64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      ARCH=""
      ;;
  esac
  if [[ -n "${OS}" && -n "${ARCH}" ]]; then
    TARGET_NODE="${BIN_DIR}/node-${OS}-${ARCH}"
    cp "$(command -v node)" "${TARGET_NODE}"
    chmod +x "${TARGET_NODE}"
    echo "[build] bundled node: ${TARGET_NODE}"
  fi
fi

echo "[build] done: ${RUNTIME_DIR}"
