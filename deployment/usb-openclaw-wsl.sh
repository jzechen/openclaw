#!/usr/bin/env bash
set -euo pipefail

# Derived from current machine config:
# - gateway.mode=local
# - gateway.port=18789
# - gateway.bind=loopback
# - gateway.auth.mode=token
# - agents.defaults.model.primary=openai-codex/gpt-5.4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACTION="${1:-run}"
DEFAULT_ROOT="${SCRIPT_DIR}/data"
USB_ROOT_INPUT="${2:-${OPENCLAW_USB_ROOT:-${DEFAULT_ROOT}}}"
EXTRA_ARG="${3:-}"
OPEN_DASHBOARD_ON_RUN=false
CONFIG_ROOT_INPUT="${OPENCLAW_CONFIG_ROOT:-${SCRIPT_DIR}/config}"

usage() {
  cat <<'USAGE'
Usage:
  usb-openclaw-wsl.sh <init|run|run-bg|stop|status> [data_root_path] [dashboard]

Examples:
  ./deployment/usb-openclaw-wsl.sh init
  ./deployment/usb-openclaw-wsl.sh run
  ./deployment/usb-openclaw-wsl.sh run-bg
  ./deployment/usb-openclaw-wsl.sh stop
USAGE
}

if [[ "${ACTION}" == "run" || "${ACTION}" == "run-bg" ]]; then
  if [[ "${USB_ROOT_INPUT}" == "dashboard" ]]; then
    USB_ROOT_INPUT="${OPENCLAW_USB_ROOT:-${DEFAULT_ROOT}}"
    OPEN_DASHBOARD_ON_RUN=true
  elif [[ "${EXTRA_ARG}" == "dashboard" ]]; then
    OPEN_DASHBOARD_ON_RUN=true
  fi
fi

mkdir -p "${USB_ROOT_INPUT}"
USB_ROOT="$(cd "${USB_ROOT_INPUT}" && pwd)"
mkdir -p "${CONFIG_ROOT_INPUT}"
CONFIG_ROOT="$(cd "${CONFIG_ROOT_INPUT}" && pwd)"

LOCAL_OPENCLAW="${SCRIPT_DIR}/bin/openclaw"
if [[ ! -x "${LOCAL_OPENCLAW}" ]]; then
  echo "[error] missing local launcher: ${LOCAL_OPENCLAW}" >&2
  exit 1
fi

resolve_node_bin() {
  local arch node_bin
  case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      echo ""
      return
      ;;
  esac
  node_bin="${SCRIPT_DIR}/bin/node-linux-${arch}"
  if [[ -x "${node_bin}" ]]; then
    echo "${node_bin}"
    return
  fi
  echo ""
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[error] missing bundled node: deployment/bin/node-linux-$(uname -m)" >&2
  echo "[hint] add Linux Node 22+ binary to deployment/bin before running in WSL." >&2
  exit 1
fi

oc() {
  "${LOCAL_OPENCLAW}" "$@"
}

STATE_DIR="${USB_ROOT}/state-wsl"
CONFIG_PATH="${CONFIG_ROOT}/openclaw-wsl.json"
WORKSPACE_DIR="${USB_ROOT}/workspace"
CODEX_HOME_DIR="${USB_ROOT}/codex-home"

mkdir -p "${STATE_DIR}" "${WORKSPACE_DIR}" "${CODEX_HOME_DIR}"

export OPENCLAW_STATE_DIR="${STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export CODEX_HOME="${CODEX_HOME_DIR}"

node_eval() {
  "${NODE_BIN}" -e "$1" "${@:2}"
}

read_gateway_token() {
  node_eval '
const fs=require("fs");
const [configPath]=process.argv.slice(1);
try{
  const cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const token=cfg?.gateway?.auth?.token;
  process.stdout.write(typeof token==="string" ? token : "");
}catch{
  process.stdout.write("");
}' "${CONFIG_PATH}"
}

generate_token() {
  node_eval 'console.log(require("crypto").randomBytes(24).toString("hex"))'
}

ensure_gateway_token() {
  local has_token
  has_token="$(node_eval 'const fs=require("fs");const p=process.argv[1];try{const c=JSON.parse(fs.readFileSync(p,"utf8"));const t=c?.gateway?.auth?.token;process.stdout.write(t?"1":"0")}catch{process.stdout.write("0")}' "${CONFIG_PATH}")"
  if [[ "${has_token}" != "1" ]]; then
    local token
    token="$(generate_token)"
    if oc config set gateway.auth.token "${token}" >/dev/null 2>&1; then
      echo "[init] generated gateway.auth.token in ${CONFIG_PATH}"
    else
      echo "[warn] failed to generate gateway.auth.token automatically"
    fi
  fi
  local resolved_token
  resolved_token="$(read_gateway_token)"
  if [[ -n "${resolved_token}" ]]; then
    export OPENCLAW_GATEWAY_TOKEN="${resolved_token}"
  fi
}

config_value_present() {
  local key="$1"
  node_eval '
const fs=require("fs");
const [configPath,key]=process.argv.slice(1);
try{
  const cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const value=key.split(".").reduce((acc,part)=>acc&&typeof acc==="object"?acc[part]:undefined,cfg);
  process.stdout.write(value === undefined || value === null || String(value) === "" ? "0" : "1");
}catch{
  process.stdout.write("0");
}' "${CONFIG_PATH}" "${key}"
}

set_config_default() {
  local key="$1"
  local value="$2"
  local present
  present="$(config_value_present "${key}")"
  if [[ "${present}" != "1" ]]; then
    if ! oc config set "${key}" "${value}" >/dev/null 2>&1; then
      echo "[warn] failed to set default config '${key}' (config may still be invalid)"
    fi
  fi
}

remove_config_key_path() {
  local key_path="$1"
  node_eval '
const fs=require("fs");
const configPath=process.argv[1];
const keyPath=process.argv[2];
if (!configPath || !keyPath) {
  process.stdout.write("0");
  process.exit(0);
}
let cfg;
try {
  cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
} catch {
  process.stdout.write("0");
  process.exit(0);
}
const parts=keyPath.split(".").filter(Boolean);
if (parts.length === 0) {
  process.stdout.write("0");
  process.exit(0);
}
let obj=cfg;
for (let i=0;i<parts.length-1;i++) {
  const part=parts[i];
  if (!obj || typeof obj !== "object" || !(part in obj)) {
    process.stdout.write("0");
    process.exit(0);
  }
  obj=obj[part];
}
const leaf=parts[parts.length-1];
if (!obj || typeof obj !== "object" || !(leaf in obj)) {
  process.stdout.write("0");
  process.exit(0);
}
delete obj[leaf];
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
process.stdout.write("1");
' "${CONFIG_PATH}" "${key_path}"
}

cleanup_known_invalid_config_keys() {
  local raw normalized paths
  raw="$(oc config validate 2>&1 || true)"
  normalized="${raw//\\n/$'\n'}"
  paths="$(printf '%s\n' "${normalized}" | awk '
/(unknown channel id:|plugin not found:)/ {
  line=$0
  sub(/^[[:space:]]*[×-]?[[:space:]]*/, "", line)
  sub(/:.*/, "", line)
  if (line != "") print line
}
' | sort -u)"
  if [[ -z "${paths}" ]]; then
    return
  fi

  local path removed_any
  removed_any=0
  while IFS= read -r path; do
    [[ -z "${path}" ]] && continue
    if [[ "$(remove_config_key_path "${path}")" == "1" ]]; then
      echo "[init] removed invalid config key: ${path}"
      removed_any=1
    fi
  done <<<"${paths}"

  if [[ "${removed_any}" == "1" ]]; then
    echo "[init] applied invalid-config cleanup from validate output"
  fi
}

ensure_valid_config_for_startup() {
  if oc config validate >/dev/null 2>&1; then
    return
  fi

  echo "[init] detected invalid config; running non-interactive doctor repair..."
  if ! oc doctor --non-interactive --fix --yes >/dev/null 2>&1; then
    echo "[warn] automatic doctor repair failed; continuing with best-effort startup."
  fi

  if oc config validate >/dev/null 2>&1; then
    echo "[init] config repaired by doctor --fix"
    return
  fi

  cleanup_known_invalid_config_keys
  if oc config validate >/dev/null 2>&1; then
    echo "[init] config repaired by key cleanup fallback"
  else
    echo "[warn] config still invalid after doctor --fix; continuing with best-effort startup."
  fi
}

print_config_value() {
  local key="$1"
  local value
  value="$(oc config get "${key}" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "${value}" ]]; then
    echo "(unset)"
    return
  fi
  echo "${value}"
}

apply_base_config() {
  ensure_valid_config_for_startup
  set_config_default gateway.mode local
  set_config_default gateway.port 18789
  set_config_default gateway.bind loopback
  set_config_default gateway.auth.mode token
  set_config_default agents.defaults.workspace "${WORKSPACE_DIR}"
  set_config_default agents.defaults.model.primary openai-codex/gpt-5.4
  ensure_gateway_token
}

print_status() {
  echo "OPENCLAW_CONFIG_ROOT=${CONFIG_ROOT}"
  echo "OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}"
  echo "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH}"
  echo "CODEX_HOME=${CODEX_HOME}"
  echo "OPENCLAW_CMD=${LOCAL_OPENCLAW}"
  print_config_value gateway.mode
  print_config_value gateway.port
  print_config_value gateway.bind
  print_config_value gateway.auth.mode
  print_config_value agents.defaults.workspace
  print_config_value agents.defaults.model.primary
}

print_dashboard_hint() {
  local mode="${1:-no-open}"
  echo "[hint] Open dashboard with tokenized URL:"
  local output url
  output="$(oc dashboard --no-open 2>&1 || true)"
  printf '%s\n' "${output}"
  url="$(printf '%s\n' "${output}" | sed -n 's/^Dashboard URL: //p' | head -n 1)"
  if [[ "${mode}" == "open" && -n "${url}" ]]; then
    if command -v xdg-open >/dev/null 2>&1; then
      if xdg-open "${url}" >/dev/null 2>&1; then
        echo "Opened in your browser. Keep that tab to control OpenClaw."
      else
        echo "[warn] Browser auto-open failed. Use the URL above."
      fi
    else
      echo "[warn] Browser auto-open is not available. Use the URL above."
    fi
  fi
}

start_gateway_background() {
  local log_dir log_file pid_file
  log_dir="${STATE_DIR}/logs"
  log_file="${log_dir}/gateway.log"
  pid_file="${STATE_DIR}/gateway.pid"
  mkdir -p "${log_dir}"
  nohup "${LOCAL_OPENCLAW}" gateway run >"${log_file}" 2>&1 &
  echo $! >"${pid_file}"
  echo "[run-bg] gateway started in background (pid=$(cat "${pid_file}"))"
  echo "[run-bg] log: ${log_file}"
}

stop_gateway_background() {
  local pid_file
  pid_file="${STATE_DIR}/gateway.pid"
  local stopped_any=0

  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      sleep 1
      if kill -0 "${pid}" >/dev/null 2>&1; then
        kill -9 "${pid}" >/dev/null 2>&1 || true
      fi
      echo "[stop] stopped gateway pid=${pid}"
      stopped_any=1
    fi
    rm -f "${pid_file}"
  fi

  # Fallback: stop orphaned background runs not tracked by pid file.
  local pids
  pids="$(pgrep -f "${LOCAL_OPENCLAW} gateway run" || true)"
  if [[ -n "${pids}" ]]; then
    while IFS= read -r p; do
      [[ -z "${p}" ]] && continue
      kill "${p}" >/dev/null 2>&1 || true
      sleep 1
      if kill -0 "${p}" >/dev/null 2>&1; then
        kill -9 "${p}" >/dev/null 2>&1 || true
      fi
      echo "[stop] stopped orphan gateway pid=${p}"
      stopped_any=1
    done <<<"${pids}"
  fi

  if [[ "${stopped_any}" != "1" ]]; then
    echo "[stop] no running background gateway process found"
  fi
}

case "${ACTION}" in
  init)
    apply_base_config
    print_status
    ;;
  run)
    apply_base_config
    print_status
    if [[ "${OPEN_DASHBOARD_ON_RUN}" == "true" ]]; then
      print_dashboard_hint open
    fi
    oc gateway run
    ;;
  run-bg)
    apply_base_config
    print_status
    if [[ "${OPEN_DASHBOARD_ON_RUN}" == "true" ]]; then
      print_dashboard_hint open
    fi
    start_gateway_background
    ;;
  stop)
    stop_gateway_background
    ;;
  status)
    print_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
