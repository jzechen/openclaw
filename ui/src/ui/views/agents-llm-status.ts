import { PROVIDER_ENV_API_KEY_CANDIDATES } from "../../../../src/agents/model-auth-env-vars.js";

const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
const ENV_VAR_PLACEHOLDER_RE = /^\$\{[^}]+\}$/;

export type ApiKeyStatusTone = "ok" | "warn" | "muted";

export type ApiKeyStatus = {
  tone: ApiKeyStatusTone;
  label: string;
};

export type AuthProfileProviderStatus = {
  status: "ok" | "expiring" | "expired" | "missing" | "static";
  profileCount: number;
};

type ApiKeySummary = {
  configured: boolean;
  redacted: boolean;
  envReference: boolean;
  secretRef: boolean;
  source: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_RE.test(value.trim());
}

function hasRedactedSentinel(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim() === REDACTED_SENTINEL;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasRedactedSentinel(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return Object.values(record).some((entry) => hasRedactedSentinel(entry));
}

function summarizeApiKey(value: unknown): ApiKeySummary {
  const stringValue = asTrimmedString(value);
  if (stringValue) {
    return {
      configured: true,
      redacted: stringValue === REDACTED_SENTINEL,
      envReference: isEnvVarPlaceholder(stringValue),
      secretRef: false,
      source: null,
    };
  }

  const record = asRecord(value);
  if (!record || Object.keys(record).length === 0) {
    return {
      configured: false,
      redacted: false,
      envReference: false,
      secretRef: false,
      source: null,
    };
  }

  const source = asTrimmedString(record.source).toLowerCase();
  const id = asTrimmedString(record.id);
  return {
    configured: true,
    redacted: hasRedactedSentinel(record),
    envReference: source === "env" || (id ? isEnvVarPlaceholder(id) : false),
    secretRef: true,
    source: source || null,
  };
}

export function resolveProviderApiKeyStatus(params: {
  providerId: string;
  configuredApiKey: unknown;
  resolvedApiKey: unknown;
  authProfileStatus?: AuthProfileProviderStatus | null;
}): ApiKeyStatus {
  if (params.authProfileStatus && params.authProfileStatus.profileCount > 0) {
    if (params.authProfileStatus.status === "ok" || params.authProfileStatus.status === "static") {
      return { tone: "ok", label: "已通过 auth-profiles 配置（已脱敏）" };
    }
    if (params.authProfileStatus.status === "expiring") {
      return { tone: "warn", label: "已通过 auth-profiles 配置（即将过期）" };
    }
    if (params.authProfileStatus.status === "expired") {
      return { tone: "warn", label: "auth-profiles 已配置，但凭证已过期" };
    }
  }

  const configSummary = summarizeApiKey(params.configuredApiKey);
  if (configSummary.configured) {
    if (configSummary.redacted) {
      if (configSummary.envReference) {
        return { tone: "ok", label: "已通过环境变量配置（已脱敏）" };
      }
      if (configSummary.secretRef) {
        return { tone: "ok", label: "已通过 SecretRef 配置（已脱敏）" };
      }
      return { tone: "ok", label: "已脱敏（配置中已设置）" };
    }

    if (configSummary.envReference) {
      return { tone: "ok", label: "已通过环境变量配置" };
    }
    if (configSummary.secretRef) {
      if (configSummary.source && configSummary.source !== "env") {
        return { tone: "ok", label: `已通过 ${configSummary.source} SecretRef 配置` };
      }
      return { tone: "ok", label: "已通过 SecretRef 配置" };
    }
    return { tone: "ok", label: "已在配置中设置" };
  }

  const resolvedSummary = summarizeApiKey(params.resolvedApiKey);
  if (resolvedSummary.configured) {
    if (resolvedSummary.envReference) {
      return { tone: "ok", label: "已通过环境变量配置（解析后）" };
    }
    if (resolvedSummary.redacted) {
      return { tone: "ok", label: "已在解析配置中生效（已脱敏）" };
    }
    return { tone: "ok", label: "已在解析配置中生效" };
  }

  const envCandidates =
    PROVIDER_ENV_API_KEY_CANDIDATES[params.providerId.trim().toLowerCase()] ?? [];
  if (envCandidates.length > 0) {
    return {
      tone: "warn",
      label: `未在配置文件中设置；可通过环境变量配置：${envCandidates.join(" / ")}`,
    };
  }

  return { tone: "muted", label: "未配置" };
}
