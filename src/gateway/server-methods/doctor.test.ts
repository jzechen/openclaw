import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/openclaw/agents/main/agent"));
const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const buildAuthHealthSummary = vi.hoisted(() =>
  vi.fn(() => ({
    now: 1_700_000_000_000,
    warnAfterMs: 86_400_000,
    profiles: [],
    providers: [],
  })),
);
const getMemorySearchManager = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../../agents/auth-health.js", () => ({
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS: 86_400_000,
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager,
}));

import { doctorHandlers } from "./doctor.js";

const invokeDoctorMemoryStatus = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.status"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorAuthStatus = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.auth.status"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  expect(respond).toHaveBeenCalledWith(
    true,
    {
      agentId: "main",
      embedding: {
        ok: false,
        error,
      },
    },
    undefined,
  );
};

describe("doctor.memory.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    ensureAuthProfileStore.mockClear();
    buildAuthHealthSummary.mockClear();
    getMemorySearchManager.mockReset();
  });

  it("returns gateway embedding probe status for the default agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "main",
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "gemini",
        embedding: { ok: true },
      },
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "openai" }),
        probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });
});

describe("doctor.auth.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    ensureAuthProfileStore.mockReset();
    buildAuthHealthSummary.mockReset();
  });

  it("returns auth-provider health for the default agent", async () => {
    const store = { profiles: { "zai:default": { provider: "zai", type: "api_key" } } };
    ensureAuthProfileStore.mockReturnValue(store);
    buildAuthHealthSummary.mockReturnValue({
      now: 1_700_000_000_000,
      warnAfterMs: 86_400_000,
      profiles: [],
      providers: [
        {
          provider: "zai",
          status: "static",
          profiles: [{ profileId: "zai:default" }],
        },
      ],
    });
    const respond = vi.fn();

    await invokeDoctorAuthStatus(respond);

    expect(resolveAgentDir).toHaveBeenCalledWith(expect.any(Object), "main");
    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw/agents/main/agent", {
      allowKeychainPrompt: false,
    });
    expect(buildAuthHealthSummary).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      store,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        now: 1_700_000_000_000,
        warnAfterMs: 86_400_000,
        providers: [
          {
            provider: "zai",
            status: "static",
            profileCount: 1,
            expiresAt: undefined,
            remainingMs: undefined,
          },
        ],
      },
      undefined,
    );
  });

  it("returns a probe error payload when auth health lookup fails", async () => {
    ensureAuthProfileStore.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    const respond = vi.fn();

    await invokeDoctorAuthStatus(respond);

    const [ok, payload] = respond.mock.calls[0] as [boolean, { error?: string }];
    expect(ok).toBe(true);
    expect(payload.error).toContain("gateway auth probe failed: store unavailable");
  });
});
