import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  type AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
};

export type DoctorAuthProviderStatusPayload = {
  provider: string;
  status: AuthProviderHealthStatus;
  profileCount: number;
  expiresAt?: number;
  remainingMs?: number;
};

export type DoctorAuthStatusPayload = {
  agentId: string;
  now: number;
  warnAfterMs: number;
  providers: DoctorAuthProviderStatusPayload[];
  error?: string;
};

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.auth.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    try {
      const agentDir = resolveAgentDir(cfg, agentId);
      const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const summary = buildAuthHealthSummary({ cfg, store });
      const payload: DoctorAuthStatusPayload = {
        agentId,
        now: summary.now,
        warnAfterMs: summary.warnAfterMs,
        providers: summary.providers.map((provider) => ({
          provider: provider.provider,
          status: provider.status,
          profileCount: provider.profiles.length,
          expiresAt: provider.expiresAt,
          remainingMs: provider.remainingMs,
        })),
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorAuthStatusPayload = {
        agentId,
        now: Date.now(),
        warnAfterMs: DEFAULT_OAUTH_WARN_MS,
        providers: [],
        error: `gateway auth probe failed: ${formatError(err)}`,
      };
      respond(true, payload, undefined);
    }
  },
  "doctor.memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
};
