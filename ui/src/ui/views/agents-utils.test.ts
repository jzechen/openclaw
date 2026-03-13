import { describe, expect, it } from "vitest";
import { resolveProviderApiKeyStatus } from "./agents-llm-status.ts";
import { resolveAgentLlmCatalog } from "./agents-llm.ts";
import {
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  sortLocaleStrings,
} from "./agents-utils.ts";

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([]);
  });
});

describe("resolveConfiguredCronModelSuggestions", () => {
  it("collects defaults primary/fallbacks, alias map keys, and per-agent model entries", () => {
    const result = resolveConfiguredCronModelSuggestions({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "smart" },
            "openai/gpt-5.2": { alias: "main" },
          },
        },
        list: {
          writer: {
            model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
          },
          planner: {
            model: "google/gemini-2.5-flash",
          },
        },
      },
    });

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns empty array for invalid or missing config shape", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } })).toEqual(
      [],
    );
  });
});

describe("sortLocaleStrings", () => {
  it("sorts values using localeCompare without relying on Array.prototype.toSorted", () => {
    expect(sortLocaleStrings(["z", "b", "a"])).toEqual(["a", "b", "z"]);
  });

  it("accepts any iterable input, including sets", () => {
    expect(sortLocaleStrings(new Set(["beta", "alpha"]))).toEqual(["alpha", "beta"]);
  });
});

describe("resolveAgentLlmCatalog", () => {
  it("collects model options from providers, defaults aliases, and current values", () => {
    const catalog = resolveAgentLlmCatalog(
      {
        models: {
          providers: {
            openai: {
              models: [
                { id: "gpt-5", name: "GPT-5" },
                { id: "gpt-5-mini", name: "GPT-5 Mini" },
              ],
            },
            anthropic: {
              models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": { alias: "main" },
              "local-dev": { alias: "local" },
            },
          },
        },
      },
      ["xai/grok-4"],
    );

    expect(catalog.options.map((entry) => entry.value)).toEqual([
      "local-dev",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "xai/grok-4",
    ]);
    expect(catalog.grouped.map((entry) => entry.provider)).toEqual(["anthropic", "openai", "xai"]);
    expect(catalog.ungrouped.map((entry) => entry.value)).toEqual(["local-dev"]);
  });

  it("adds missing current values so existing selections remain editable", () => {
    const catalog = resolveAgentLlmCatalog(
      {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5", name: "GPT-5" }],
            },
          },
        },
      },
      ["openai/gpt-5", "deepseek/deepseek-r1"],
    );

    expect(catalog.options.some((entry) => entry.value === "deepseek/deepseek-r1")).toBe(true);
    expect(catalog.options.find((entry) => entry.value === "deepseek/deepseek-r1")?.label).toBe(
      "Current (deepseek/deepseek-r1)",
    );
  });
});

describe("resolveProviderApiKeyStatus", () => {
  it("prefers auth-profiles status when provider credentials are stored there", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "",
      resolvedApiKey: undefined,
      authProfileStatus: { status: "static", profileCount: 1 },
    });

    expect(result.tone).toBe("ok");
    expect(result.label).toBe("已通过 auth-profiles 配置（已脱敏）");
  });

  it("surfaces expiring auth-profiles credentials as warning", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "",
      resolvedApiKey: undefined,
      authProfileStatus: { status: "expiring", profileCount: 1 },
    });

    expect(result.tone).toBe("warn");
    expect(result.label).toContain("即将过期");
  });

  it("shows redacted status when apiKey is masked in config", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "__OPENCLAW_REDACTED__",
      resolvedApiKey: undefined,
    });

    expect(result.tone).toBe("ok");
    expect(result.label).toBe("已脱敏（配置中已设置）");
  });

  it("shows env-configured status for env placeholders", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "${ZAI_API_KEY}",
      resolvedApiKey: undefined,
    });

    expect(result.tone).toBe("ok");
    expect(result.label).toBe("已通过环境变量配置");
  });

  it("shows parsed/resolved status when only resolved config has a key", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "",
      resolvedApiKey: "__OPENCLAW_REDACTED__",
    });

    expect(result.tone).toBe("ok");
    expect(result.label).toBe("已在解析配置中生效（已脱敏）");
  });

  it("shows env guidance when key is absent from config", () => {
    const result = resolveProviderApiKeyStatus({
      providerId: "zai",
      configuredApiKey: "",
      resolvedApiKey: undefined,
    });

    expect(result.tone).toBe("warn");
    expect(result.label).toContain("可通过环境变量配置");
    expect(result.label).toContain("ZAI_API_KEY");
  });
});
