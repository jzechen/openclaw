import { sortLocaleStrings } from "./agents-utils.ts";

type AgentModelEntry = { alias?: unknown };
type ProviderModelEntry = { id?: unknown; name?: unknown };

type ConfigSnapshot = {
  agents?: {
    defaults?: {
      models?: Record<string, AgentModelEntry>;
    };
  };
  models?: {
    providers?: Record<string, { models?: ProviderModelEntry[] }>;
  };
};

export type AgentLlmOption = {
  value: string;
  label: string;
  provider: string | null;
};

export type AgentLlmCatalog = {
  options: AgentLlmOption[];
  grouped: Array<{ provider: string; options: AgentLlmOption[] }>;
  ungrouped: AgentLlmOption[];
};

function parseModelRef(value: string): { provider: string; model: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIndex).trim(),
    model: trimmed.slice(slashIndex + 1).trim(),
  };
}

function buildOption(value: string, label?: string): AgentLlmOption | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }
  const parsed = parseModelRef(trimmedValue);
  return {
    value: trimmedValue,
    label: (label?.trim() || trimmedValue).trim(),
    provider: parsed?.provider || null,
  };
}

function mergeOption(existing: AgentLlmOption, next: AgentLlmOption): AgentLlmOption {
  const nextLabel =
    existing.label === existing.value && next.label !== next.value ? next.label : existing.label;
  return {
    value: existing.value,
    label: nextLabel,
    provider: existing.provider ?? next.provider,
  };
}

function addOption(target: Map<string, AgentLlmOption>, option: AgentLlmOption | null): void {
  if (!option) {
    return;
  }
  const key = option.value.toLowerCase();
  const existing = target.get(key);
  if (!existing) {
    target.set(key, option);
    return;
  }
  target.set(key, mergeOption(existing, option));
}

function resolveProviderModelLabel(entry: ProviderModelEntry, modelId: string): string {
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name || name === modelId) {
    return modelId;
  }
  return `${name} (${modelId})`;
}

export function resolveAgentLlmCatalog(
  configForm: Record<string, unknown> | null,
  currentValues: string[] = [],
): AgentLlmCatalog {
  const cfg = configForm as ConfigSnapshot | null;
  const optionMap = new Map<string, AgentLlmOption>();

  const providers = cfg?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [providerId, providerRaw] of Object.entries(providers)) {
      const provider = providerId.trim();
      if (!provider) {
        continue;
      }
      const models = Array.isArray(providerRaw?.models) ? providerRaw.models : [];
      for (const model of models) {
        const modelId = typeof model?.id === "string" ? model.id.trim() : "";
        if (!modelId) {
          continue;
        }
        addOption(
          optionMap,
          buildOption(`${provider}/${modelId}`, resolveProviderModelLabel(model, modelId)),
        );
      }
    }
  }

  const configuredModels = cfg?.agents?.defaults?.models;
  if (configuredModels && typeof configuredModels === "object") {
    for (const [modelRef, entry] of Object.entries(configuredModels)) {
      const trimmedRef = modelRef.trim();
      if (!trimmedRef) {
        continue;
      }
      const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
      const label = alias && alias !== trimmedRef ? `${alias} (${trimmedRef})` : trimmedRef;
      addOption(optionMap, buildOption(trimmedRef, label));
    }
  }

  for (const value of currentValues) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    addOption(optionMap, buildOption(trimmed, `Current (${trimmed})`));
  }

  const options = Array.from(optionMap.values());
  options.sort((a, b) => {
    const providerCompare = (a.provider ?? "~").localeCompare(b.provider ?? "~");
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return a.value.localeCompare(b.value);
  });

  const groupedMap = new Map<string, AgentLlmOption[]>();
  const ungrouped: AgentLlmOption[] = [];
  for (const option of options) {
    if (!option.provider) {
      ungrouped.push(option);
      continue;
    }
    const list = groupedMap.get(option.provider) ?? [];
    list.push(option);
    groupedMap.set(option.provider, list);
  }

  const grouped = sortLocaleStrings(groupedMap.keys()).map((provider) => ({
    provider,
    options: [...(groupedMap.get(provider) ?? [])].toSorted((a, b) => a.label.localeCompare(b.label)),
  }));

  return { options, grouped, ungrouped };
}
