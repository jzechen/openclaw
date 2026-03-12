#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const SEA_RESOURCE_NAME = "NODE_SEA_BLOB";
const RUNTIME_ASSET_KEY = "openclaw-runtime.tar.gz";
const LITE_EXCLUDE_PREFIXES = [
  "node_modules/@img",
  "node_modules/@napi-rs",
  "node_modules/@node-llama-cpp",
  "node_modules/node-llama-cpp",
  "node_modules/playwright-core",
  "node_modules/sharp",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const deploymentDir = scriptDir;
const binDir = path.join(deploymentDir, "bin");

const parsed = parseArgs(process.argv.slice(2));
const platform = normalizePlatform(process.platform);
const arch = normalizeArch(process.arch);
const outputExt = platform === "win" ? ".exe" : "";
const defaultRuntimeDir = path.join(binDir, "runtime");
const defaultOutput = path.join(binDir, `openclaw-sea-${platform}-${arch}${outputExt}`);
const defaultNodeBin =
  platform === "win"
    ? path.join(binDir, `node-win-${arch}.exe`)
    : path.join(binDir, `node-${platform}-${arch}`);

const runtimeDir = path.resolve(parsed.runtimeDir ?? defaultRuntimeDir);
const outputPath = path.resolve(parsed.output ?? defaultOutput);
const nodeBin = path.resolve(parsed.nodeBin ?? defaultNodeBin);
const workDir = path.resolve(parsed.workDir ?? path.join(deploymentDir, ".sea-build"));
const keepTemp = parsed.keepTemp ?? false;
const stripRuntime = parsed.stripRuntime ?? false;
const lite = parsed.lite ?? false;

const launcherPath = path.join(workDir, "sea-launcher.cjs");
const seaConfigPath = path.join(workDir, "sea-config.json");
const seaBlobPath = path.join(workDir, "sea-prep.blob");
const runtimeTarGzPath = path.join(workDir, "runtime.tar.gz");

await main();

async function main() {
  assertPathExists(runtimeDir, "runtime dir");

  if (!(await pathExists(nodeBin))) {
    throw new Error(
      `missing Node binary for SEA build: ${nodeBin}\n` +
        "hint: run deployment/build-local-runtime first, or pass --node-bin",
    );
  }

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  log(`packing runtime tar.gz from ${runtimeDir}`);
  if (lite) {
    log("using lite profile (excludes heavy optional dependencies)");
  }
  await tar.c(
    {
      cwd: runtimeDir,
      file: runtimeTarGzPath,
      portable: true,
      noMtime: true,
      noPax: false,
      gzip: true,
      filter: lite
        ? (entryPath) => {
            const normalized = normalizeTarEntryPath(entryPath);
            return !LITE_EXCLUDE_PREFIXES.some(
              (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
            );
          }
        : undefined,
    },
    ["."],
  );

  const runtimeHash = await sha256File(runtimeTarGzPath);
  log(`runtime sha256: ${runtimeHash}`);

  const launcherSource = createLauncherSource({
    runtimeHash,
    assetKey: RUNTIME_ASSET_KEY,
  });
  await fs.writeFile(launcherPath, launcherSource, "utf8");

  await fs.writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: launcherPath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        assets: {
          [RUNTIME_ASSET_KEY]: runtimeTarGzPath,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  log("building SEA blob");
  runChecked(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    cwd: repoRoot,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(nodeBin, outputPath);
  if (platform !== "win") {
    await fs.chmod(outputPath, 0o755);
  }

  if (platform === "darwin") {
    runBestEffort("codesign", ["--remove-signature", outputPath]);
  }

  log("injecting SEA blob into node binary");
  runPostject(outputPath, seaBlobPath, platform);

  if (platform === "darwin") {
    runBestEffort("codesign", ["--sign", "-", "--force", outputPath]);
  }

  if (stripRuntime) {
    log(`removing runtime dir: ${runtimeDir}`);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }

  if (!keepTemp) {
    await fs.rm(workDir, { recursive: true, force: true });
  } else {
    log(`kept temp files at ${workDir}`);
  }

  log(`done: ${outputPath}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--runtime-dir":
        out.runtimeDir = readNextValue(argv, i, arg);
        i += 1;
        break;
      case "--output":
        out.output = readNextValue(argv, i, arg);
        i += 1;
        break;
      case "--node-bin":
        out.nodeBin = readNextValue(argv, i, arg);
        i += 1;
        break;
      case "--work-dir":
        out.workDir = readNextValue(argv, i, arg);
        i += 1;
        break;
      case "--keep-temp":
        out.keepTemp = true;
        break;
      case "--lite":
        out.lite = true;
        break;
      case "--strip-runtime":
        out.stripRuntime = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function readNextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function printUsageAndExit(code) {
  const usage = `
Usage:
  node deployment/build-sea-binary.mjs [options]

Options:
  --runtime-dir <path>   Runtime directory to embed (default: deployment/bin/runtime)
  --node-bin <path>      Node binary used as SEA base (default: deployment/bin/node-<os>-<arch>)
  --output <path>        SEA binary output path (default: deployment/bin/openclaw-sea-<os>-<arch>)
  --work-dir <path>      Temp workspace (default: deployment/.sea-build)
  --lite                 Exclude heavy optional deps (smaller SEA, reduced capabilities)
  --strip-runtime        Delete runtime dir after SEA build
  --keep-temp            Keep temp files for debugging
  -h, --help             Show this help
`.trim();
  process.stdout.write(`${usage}\n`);
  process.exit(code);
}

function normalizePlatform(raw) {
  switch (raw) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "win";
    default:
      throw new Error(`unsupported platform for SEA build: ${raw}`);
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`unsupported architecture for SEA build: ${raw}`);
  }
}

function runPostject(binaryPath, blobPath, platformName) {
  const args = [
    binaryPath,
    SEA_RESOURCE_NAME,
    blobPath,
    "--sentinel-fuse",
    SENTINEL_FUSE,
    "--overwrite",
  ];
  if (platformName === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const postjectCmd = process.platform === "win32" ? "postject.cmd" : "postject";
  const attempts = [
    { cmd: postjectCmd, args },
    { cmd: pnpmCmd, args: ["exec", "postject", ...args] },
    { cmd: pnpmCmd, args: ["dlx", "postject", ...args] },
    { cmd: npxCmd, args: ["--yes", "postject", ...args] },
  ];
  const errors = [];
  for (const attempt of attempts) {
    const result = runMaybe(attempt.cmd, attempt.args, { cwd: repoRoot });
    if (result.ok) {
      return;
    }
    errors.push(result.message);
  }
  const liteHint = lite
    ? ""
    : "\nhint: retry with --lite to exclude heavy optional dependencies and reduce blob size.";
  throw new Error(`postject failed:\n${errors.map((msg) => `- ${msg}`).join("\n")}${liteHint}`);
}

function runChecked(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const message = [
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
      stdout ? `stdout: ${stdout}` : "",
      stderr ? `stderr: ${stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(message);
  }
}

function runBestEffort(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    const reason = result.error
      ? String(result.error)
      : `${command} exited with code ${result.status}: ${(result.stderr ?? "").trim()}`;
    log(`warn: ${reason}`);
  }
}

function runMaybe(command, args, opts = {}) {
  const isCmdShim =
    process.platform === "win32" && (command.toLowerCase().endsWith(".cmd") || command.endsWith(".bat"));
  const result = isCmdShim
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], {
        cwd: opts.cwd,
        stdio: "pipe",
        encoding: "utf8",
      })
    : spawnSync(command, args, {
        cwd: opts.cwd,
        stdio: "pipe",
        encoding: "utf8",
      });
  if (result.error) {
    return { ok: false, message: `${command}: ${String(result.error)}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const details = [stdout, stderr].filter(Boolean).join(" | ");
    return {
      ok: false,
      message: `${command} ${args.join(" ")} exited ${result.status}${details ? ` (${details})` : ""}`,
    };
  }
  return { ok: true };
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function assertPathExists(filePath, label) {
  if (!filePath) {
    throw new Error(`missing ${label} path`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function log(message) {
  process.stdout.write(`[sea] ${message}\n`);
}

function normalizeTarEntryPath(entryPath) {
  return entryPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function createLauncherSource(params) {
  const runtimeHash = JSON.stringify(params.runtimeHash);
  const assetKey = JSON.stringify(params.assetKey);
  return `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sea = require("node:sea");
const { gunzipSync } = require("node:zlib");
const { pathToFileURL } = require("node:url");

const RUNTIME_HASH = ${runtimeHash};
const RUNTIME_ASSET_KEY = ${assetKey};
const RUNTIME_MARKER_FILE = ".openclaw-sea-runtime-hash";

function runtimeCacheRoot() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "openclaw", "sea-runtime");
  }
  const xdg = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  return path.join(xdg, "openclaw", "sea-runtime");
}

function runtimeDir() {
  return path.join(runtimeCacheRoot(), RUNTIME_HASH);
}

function readString(buf, start, size) {
  const raw = buf.subarray(start, start + size).toString("utf8");
  const zero = raw.indexOf("\\u0000");
  return (zero >= 0 ? raw.slice(0, zero) : raw).trim();
}

function parseOctal(buf, start, size) {
  const raw = readString(buf, start, size).replace(/\\u0000/g, "").trim();
  if (!raw) return 0;
  return Number.parseInt(raw, 8) || 0;
}

function parsePaxHeader(content) {
  const entries = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space <= offset) break;
    const len = Number.parseInt(content.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recordEnd = offset + len;
    const record = content.subarray(space + 1, recordEnd - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      entries[key] = value;
    }
    offset = recordEnd;
  }
  return entries;
}

function ensureSafePath(baseDir, relPath) {
  const cleaned = relPath.replace(/\\\\\\\\/g, "/").replace(/^\\/+/, "").replace(/^\\.\\/+/, "");
  if (!cleaned) return null;
  const target = path.resolve(baseDir, cleaned);
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("unsafe tar entry: " + relPath);
  }
  return target;
}

function resolveSafeLinkTargets(baseDir, entryTargetPath, rawLinkPath) {
  const normalized = rawLinkPath.replace(/\\\\\\\\/g, "/").replace(/\\u0000/g, "");
  const base = path.resolve(baseDir);
  const candidates = normalized.startsWith("/")
    ? [path.resolve(baseDir, "." + normalized)]
    : [path.resolve(baseDir, normalized), path.resolve(path.dirname(entryTargetPath), normalized)];

  const safe = [];
  for (const resolved of candidates) {
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error("unsafe tar link target: " + rawLinkPath);
    }
    if (!safe.includes(resolved)) {
      safe.push(resolved);
    }
  }
  return safe;
}

function applyMode(target, mode) {
  if (process.platform === "win32") return;
  if (!mode) return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    // ignore mode errors
  }
}

function extractTarBuffer(buffer, destination) {
  let offset = 0;
  let pendingPax = null;
  let globalPax = null;
  const pendingLinks = [];
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const baseName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const rawPath = prefix ? prefix + "/" + baseName : baseName;
    const size = parseOctal(header, 124, 12);
    const mode = parseOctal(header, 100, 8);
    const rawLinkName = readString(header, 157, 100);
    const typeByte = header[156];
    const typeFlag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new Error("invalid tar entry: truncated data");
    }
    const content = buffer.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeFlag === "x") {
      pendingPax = parsePaxHeader(content);
      continue;
    }
    if (typeFlag === "g") {
      globalPax = parsePaxHeader(content);
      continue;
    }

    const pax = { ...(globalPax || {}), ...(pendingPax || {}) };
    pendingPax = null;
    const entryPath = pax.path || rawPath;
    const target = ensureSafePath(destination, entryPath);
    if (!target) {
      continue;
    }

    if (typeFlag === "5" || entryPath.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      applyMode(target, mode);
      continue;
    }
    if (typeFlag === "1" || typeFlag === "2") {
      const linkName = pax.linkpath || rawLinkName;
      pendingLinks.push({ entryPath, linkName, mode, target });
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "\\u0000") {
      throw new Error("unsupported tar entry type: " + typeFlag + " for " + entryPath);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    applyMode(target, mode);
  }

  const unresolved = [...pendingLinks];
  let progressed = true;
  while (unresolved.length > 0 && progressed) {
    progressed = false;
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      const link = unresolved[i];
      const linkTargets = resolveSafeLinkTargets(destination, link.target, link.linkName);
      const existing = linkTargets.find((candidate) => fs.existsSync(candidate));
      if (!existing) {
        continue;
      }
      fs.mkdirSync(path.dirname(link.target), { recursive: true });
      try {
        fs.linkSync(existing, link.target);
      } catch {
        fs.copyFileSync(existing, link.target);
      }
      applyMode(link.target, link.mode);
      unresolved.splice(i, 1);
      progressed = true;
    }
  }

  if (unresolved.length > 0) {
    const first = unresolved[0];
    throw new Error("tar link target missing: " + first.linkName + " for " + first.entryPath);
  }
}

function getTarAssetBuffer() {
  if (!sea.isSea()) {
    throw new Error("SEA runtime expected.");
  }
  if (typeof sea.getRawAsset === "function") {
    const raw = sea.getRawAsset(RUNTIME_ASSET_KEY);
    if (raw) {
      return Buffer.from(raw);
    }
  }
  if (typeof sea.getAsset === "function") {
    const raw = sea.getAsset(RUNTIME_ASSET_KEY);
    if (raw) {
      return Buffer.from(raw);
    }
  }
  throw new Error("missing SEA runtime asset: " + RUNTIME_ASSET_KEY);
}

function ensureRuntimeExtracted() {
  const dir = runtimeDir();
  const marker = path.join(dir, RUNTIME_MARKER_FILE);
  const entry = path.join(dir, "openclaw.mjs");
  const hasValidMarker =
    fs.existsSync(marker) &&
    fs.existsSync(entry) &&
    fs.readFileSync(marker, "utf8").trim() === RUNTIME_HASH;
  if (hasValidMarker) {
    return dir;
  }

  fs.mkdirSync(runtimeCacheRoot(), { recursive: true });
  const tmp = path.join(
    runtimeCacheRoot(),
    ".tmp-" + RUNTIME_HASH + "-" + process.pid + "-" + Date.now().toString(36),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const tarBuffer = gunzipSync(getTarAssetBuffer());
  extractTarBuffer(tarBuffer, tmp);
  fs.writeFileSync(path.join(tmp, RUNTIME_MARKER_FILE), RUNTIME_HASH + "\\n", "utf8");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

const run = async () => {
  const extractedRuntime = ensureRuntimeExtracted();
  process.env.OPENCLAW_SEA_RUNTIME_DIR = extractedRuntime;
  process.env.OPENCLAW_SEA_RUNTIME_HASH = RUNTIME_HASH;

  const entryPath = path.join(extractedRuntime, "openclaw.mjs");
  const rawArgv = process.argv.filter((arg) => !String(arg).startsWith("--disable-warning="));
  process.env.OPENCLAW_SEA_ORIGINAL_ARGV1 = rawArgv[1] ?? "";
  const userArgs = rawArgv
    .slice(1)
    .filter((arg) => !String(arg).endsWith("openclaw.mjs") && !String(arg).endsWith("sea-launcher.cjs"));
  process.argv = [rawArgv[0] ?? process.execPath, entryPath, ...userArgs];

  await import(pathToFileURL(entryPath).href);
};

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
}
