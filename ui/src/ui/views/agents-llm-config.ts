import { html, nothing } from "lit";
import { MODEL_APIS } from "../../../../src/config/types.models.js";
import { resolveProviderApiKeyStatus } from "./agents-llm-status.ts";
import { resolveAgentLlmCatalog } from "./agents-llm.ts";
import { sortLocaleStrings } from "./agents-utils.ts";
import type { DoctorAuthStatusSnapshot } from "../types.ts";

type Path = Array<string | number>;

const MODEL_AUTH_OPTIONS = ["api-key", "aws-sdk", "oauth", "token"] as const;

const DEFAULT_PROVIDER_CONFIG = {
  baseUrl: "",
  models: [],
};

const DEFAULT_MODEL_CONFIG = {
  id: "",
  name: "",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 8192,
  maxTokens: 4096,
};

export type LlmConfigPanelProps = {
  configForm: Record<string, unknown> | null;
  configResolved: Record<string, unknown> | null;
  authStatus: DoctorAuthStatusSnapshot | null;
  configLoading: boolean;
  configSaving: boolean;
  onSetConfigValue: (path: Path, value: unknown) => void;
  onRemoveConfigValue: (path: Path) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function stringifyFieldValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveProviders(configForm: Record<string, unknown> | null): Record<string, unknown> {
  const models = asRecord(configForm?.models);
  const providers = asRecord(models?.providers);
  return providers ?? {};
}

function resolveAliases(configForm: Record<string, unknown> | null): Record<string, unknown> {
  const agents = asRecord(configForm?.agents);
  const defaults = asRecord(agents?.defaults);
  const models = asRecord(defaults?.models);
  return models ?? {};
}

function resolveAuthProfileProviderStatus(
  authStatus: DoctorAuthStatusSnapshot | null,
  providerId: string,
): { status: "ok" | "expiring" | "expired" | "missing" | "static"; profileCount: number } | null {
  if (!authStatus || !Array.isArray(authStatus.providers) || !providerId.trim()) {
    return null;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  const match = authStatus.providers.find(
    (entry) => entry.provider.trim().toLowerCase() === normalizedProviderId,
  );
  if (!match || (match.profileCount ?? 0) <= 0) {
    return null;
  }
  return {
    status: match.status,
    profileCount: match.profileCount,
  };
}

function findNextProviderId(existing: Set<string>): string {
  let index = 1;
  while (true) {
    const candidate = `provider-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function ensureModelInputs(entry: unknown): string[] {
  const record = asRecord(entry);
  const raw = asArray(record?.input);
  const values = raw
    .map((item) => asTrimmedString(item))
    .filter((item): item is "text" | "image" => item === "text" || item === "image");
  return values.length > 0 ? values : ["text"];
}

function updateModelInputModes(
  props: LlmConfigPanelProps,
  path: Path,
  current: string[],
  mode: "text" | "image",
  enabled: boolean,
) {
  const next = enabled ? [...new Set([...current, mode])] : current.filter((item) => item !== mode);
  props.onSetConfigValue(path, next.length > 0 ? next : ["text"]);
}

export function renderLlmConfigPanel(props: LlmConfigPanelProps) {
  const disabled = !props.configForm || props.configLoading || props.configSaving;
  const providers = resolveProviders(props.configForm);
  const resolvedProviders = resolveProviders(props.configResolved);
  const providerIds = sortLocaleStrings(Object.keys(providers));
  const aliases = resolveAliases(props.configForm);
  const aliasIds = sortLocaleStrings(Object.keys(aliases));
  const modelCatalog = resolveAgentLlmCatalog(props.configForm);
  const availableAliasRefs = modelCatalog.options.map((option) => option.value);

  const handleAddProvider = () => {
    const id = findNextProviderId(new Set(providerIds));
    props.onSetConfigValue(["models", "providers", id], DEFAULT_PROVIDER_CONFIG);
  };

  const handleAddAlias = () => {
    const fallbackId =
      availableAliasRefs.find((entry) => !aliasIds.includes(entry)) ?? "provider/model";
    props.onSetConfigValue(["agents", "defaults", "models", fallbackId], { alias: "" });
  };

  return html`
    <section class="card llm-config-card">
      <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
        <div>
          <div class="card-title">LLM Providers</div>
          <div class="card-sub">Visual CRUD for models.providers and provider model catalogs.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${disabled} @click=${handleAddProvider}>
          Add provider
        </button>
      </div>

      ${
        providerIds.length === 0
          ? html`
              <div class="llm-empty muted">No model providers configured.</div>
            `
          : providerIds.map((providerId) => {
              const provider = asRecord(providers[providerId]) ?? {};
              const resolvedProvider = asRecord(resolvedProviders[providerId]) ?? {};
              const providerPath: Path = ["models", "providers", providerId];
              const models = asArray(provider.models);
              const apiKeyValue = stringifyFieldValue(provider.apiKey);
              const apiKeyStatus = resolveProviderApiKeyStatus({
                providerId,
                configuredApiKey: provider.apiKey,
                resolvedApiKey: resolvedProvider.apiKey,
                authProfileStatus: resolveAuthProfileProviderStatus(props.authStatus, providerId),
              });
              const headersValue = stringifyFieldValue(provider.headers);
              const providerRecord = { ...providers };
              return html`
                <div class="llm-provider-card">
                  <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
                    <label class="field" style="flex: 1;">
                      <span>Provider ID</span>
                      <input
                        .value=${providerId}
                        ?disabled=${disabled}
                        @change=${(e: Event) => {
                          const nextId = asTrimmedString((e.target as HTMLInputElement).value);
                          if (
                            !nextId ||
                            nextId === providerId ||
                            providerRecord[nextId] !== undefined
                          ) {
                            return;
                          }
                          const nextProviders = {
                            ...providerRecord,
                            [nextId]: providerRecord[providerId],
                          };
                          delete nextProviders[providerId];
                          props.onSetConfigValue(["models", "providers"], nextProviders);
                        }}
                      />
                    </label>
                    <button
                      class="btn btn--sm danger"
                      ?disabled=${disabled}
                      @click=${() => props.onRemoveConfigValue(providerPath)}
                    >
                      Remove provider
                    </button>
                  </div>

                  <div class="llm-provider-grid">
                    <label class="field">
                      <span>Base URL</span>
                      <input
                        .value=${asTrimmedString(provider.baseUrl)}
                        ?disabled=${disabled}
                        @input=${(e: Event) =>
                          props.onSetConfigValue(
                            [...providerPath, "baseUrl"],
                            (e.target as HTMLInputElement).value,
                          )}
                      />
                    </label>
                    <label class="field">
                      <span>Auth</span>
                      <select
                        .value=${asTrimmedString(provider.auth)}
                        ?disabled=${disabled}
                        @change=${(e: Event) => {
                          const next = asTrimmedString((e.target as HTMLSelectElement).value);
                          if (next) {
                            props.onSetConfigValue([...providerPath, "auth"], next);
                            return;
                          }
                          props.onRemoveConfigValue([...providerPath, "auth"]);
                        }}
                      >
                        <option value="">Default</option>
                        ${MODEL_AUTH_OPTIONS.map(
                          (option) => html`<option value=${option}>${option}</option>`,
                        )}
                      </select>
                    </label>
                    <label class="field">
                      <span>API Adapter</span>
                      <select
                        .value=${asTrimmedString(provider.api)}
                        ?disabled=${disabled}
                        @change=${(e: Event) => {
                          const next = asTrimmedString((e.target as HTMLSelectElement).value);
                          if (next) {
                            props.onSetConfigValue([...providerPath, "api"], next);
                            return;
                          }
                          props.onRemoveConfigValue([...providerPath, "api"]);
                        }}
                      >
                        <option value="">Default</option>
                        ${MODEL_APIS.map((api) => html`<option value=${api}>${api}</option>`)}
                      </select>
                    </label>
                    <label class="field">
                      <span>API Key / SecretRef</span>
                      <input
                        .value=${apiKeyValue}
                        ?disabled=${disabled}
                        placeholder='Plain key or {"source":"env","provider":"default","id":"OPENAI_API_KEY"}'
                        @change=${(e: Event) => {
                          const nextRaw = (e.target as HTMLInputElement).value;
                          const nextValue = parseJsonValue(nextRaw);
                          if (nextValue === undefined) {
                            props.onRemoveConfigValue([...providerPath, "apiKey"]);
                            return;
                          }
                          props.onSetConfigValue([...providerPath, "apiKey"], nextValue);
                        }}
                      />
                      <div class=${`llm-api-key-status llm-api-key-status--${apiKeyStatus.tone}`}>
                        ${apiKeyStatus.label}
                      </div>
                    </label>
                  </div>

                  <div class="llm-provider-grid llm-provider-grid--compact">
                    <label class="field checkbox">
                      <input
                        type="checkbox"
                        .checked=${asBoolean(provider.authHeader)}
                        ?disabled=${disabled}
                        @change=${(e: Event) =>
                          props.onSetConfigValue(
                            [...providerPath, "authHeader"],
                            (e.target as HTMLInputElement).checked,
                          )}
                      />
                      <span>Auth Header</span>
                    </label>
                    <label class="field checkbox">
                      <input
                        type="checkbox"
                        .checked=${asBoolean(provider.injectNumCtxForOpenAICompat)}
                        ?disabled=${disabled}
                        @change=${(e: Event) =>
                          props.onSetConfigValue(
                            [...providerPath, "injectNumCtxForOpenAICompat"],
                            (e.target as HTMLInputElement).checked,
                          )}
                      />
                      <span>Inject num_ctx (OpenAI compat)</span>
                    </label>
                  </div>

                  <label class="field">
                    <span>Provider Headers (JSON object)</span>
                    <textarea
                      rows="3"
                      .value=${headersValue}
                      ?disabled=${disabled}
                      @change=${(e: Event) => {
                        const parsed = parseJsonObject((e.target as HTMLTextAreaElement).value);
                        if (parsed === undefined) {
                          props.onRemoveConfigValue([...providerPath, "headers"]);
                          return;
                        }
                        if (parsed) {
                          props.onSetConfigValue([...providerPath, "headers"], parsed);
                        }
                      }}
                    ></textarea>
                  </label>

                  <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
                    <div class="label">Models (${models.length})</div>
                    <button
                      class="btn btn--sm"
                      ?disabled=${disabled}
                      @click=${() =>
                        props.onSetConfigValue(
                          [...providerPath, "models", models.length],
                          DEFAULT_MODEL_CONFIG,
                        )}
                    >
                      Add model
                    </button>
                  </div>

                  ${
                    models.length === 0
                      ? html`
                          <div class="llm-empty muted">No models in this provider.</div>
                        `
                      : models.map((modelEntry, index) => {
                          const model = asRecord(modelEntry) ?? {};
                          const modelPath: Path = [...providerPath, "models", index];
                          const cost = asRecord(model.cost) ?? {};
                          const inputs = ensureModelInputs(model);
                          return html`
                            <div class="llm-model-card">
                              <div class="llm-model-grid">
                                <label class="field">
                                  <span>Model ID</span>
                                  <input
                                    .value=${asTrimmedString(model.id)}
                                    ?disabled=${disabled}
                                    @input=${(e: Event) =>
                                      props.onSetConfigValue(
                                        [...modelPath, "id"],
                                        (e.target as HTMLInputElement).value,
                                      )}
                                  />
                                </label>
                                <label class="field">
                                  <span>Name</span>
                                  <input
                                    .value=${asTrimmedString(model.name)}
                                    ?disabled=${disabled}
                                    @input=${(e: Event) =>
                                      props.onSetConfigValue(
                                        [...modelPath, "name"],
                                        (e.target as HTMLInputElement).value,
                                      )}
                                  />
                                </label>
                                <label class="field">
                                  <span>API Adapter</span>
                                  <select
                                    .value=${asTrimmedString(model.api)}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const next = asTrimmedString(
                                        (e.target as HTMLSelectElement).value,
                                      );
                                      if (next) {
                                        props.onSetConfigValue([...modelPath, "api"], next);
                                        return;
                                      }
                                      props.onRemoveConfigValue([...modelPath, "api"]);
                                    }}
                                  >
                                    <option value="">Provider default</option>
                                    ${MODEL_APIS.map((api) => html`<option value=${api}>${api}</option>`)}
                                  </select>
                                </label>
                                <label class="field checkbox">
                                  <input
                                    type="checkbox"
                                    .checked=${asBoolean(model.reasoning)}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) =>
                                      props.onSetConfigValue(
                                        [...modelPath, "reasoning"],
                                        (e.target as HTMLInputElement).checked,
                                      )}
                                  />
                                  <span>Reasoning</span>
                                </label>
                              </div>

                              <div class="llm-model-grid llm-model-grid--compact">
                                <label class="field checkbox">
                                  <input
                                    type="checkbox"
                                    .checked=${inputs.includes("text")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) =>
                                      updateModelInputModes(
                                        props,
                                        [...modelPath, "input"],
                                        inputs,
                                        "text",
                                        (e.target as HTMLInputElement).checked,
                                      )}
                                  />
                                  <span>Input: text</span>
                                </label>
                                <label class="field checkbox">
                                  <input
                                    type="checkbox"
                                    .checked=${inputs.includes("image")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) =>
                                      updateModelInputModes(
                                        props,
                                        [...modelPath, "input"],
                                        inputs,
                                        "image",
                                        (e.target as HTMLInputElement).checked,
                                      )}
                                  />
                                  <span>Input: image</span>
                                </label>
                                <label class="field">
                                  <span>Context Window</span>
                                  <input
                                    type="number"
                                    .value=${String(asNumber(model.contextWindow) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([...modelPath, "contextWindow"]);
                                        return;
                                      }
                                      props.onSetConfigValue(
                                        [...modelPath, "contextWindow"],
                                        parsed,
                                      );
                                    }}
                                  />
                                </label>
                                <label class="field">
                                  <span>Max Tokens</span>
                                  <input
                                    type="number"
                                    .value=${String(asNumber(model.maxTokens) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([...modelPath, "maxTokens"]);
                                        return;
                                      }
                                      props.onSetConfigValue([...modelPath, "maxTokens"], parsed);
                                    }}
                                  />
                                </label>
                              </div>

                              <div class="llm-model-grid">
                                <label class="field">
                                  <span>Cost Input</span>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    .value=${String(asNumber(cost.input) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([...modelPath, "cost", "input"]);
                                        return;
                                      }
                                      props.onSetConfigValue(
                                        [...modelPath, "cost", "input"],
                                        parsed,
                                      );
                                    }}
                                  />
                                </label>
                                <label class="field">
                                  <span>Cost Output</span>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    .value=${String(asNumber(cost.output) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([...modelPath, "cost", "output"]);
                                        return;
                                      }
                                      props.onSetConfigValue(
                                        [...modelPath, "cost", "output"],
                                        parsed,
                                      );
                                    }}
                                  />
                                </label>
                                <label class="field">
                                  <span>Cost Cache Read</span>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    .value=${String(asNumber(cost.cacheRead) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([
                                          ...modelPath,
                                          "cost",
                                          "cacheRead",
                                        ]);
                                        return;
                                      }
                                      props.onSetConfigValue(
                                        [...modelPath, "cost", "cacheRead"],
                                        parsed,
                                      );
                                    }}
                                  />
                                </label>
                                <label class="field">
                                  <span>Cost Cache Write</span>
                                  <input
                                    type="number"
                                    step="0.000001"
                                    .value=${String(asNumber(cost.cacheWrite) ?? "")}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = asNumber((e.target as HTMLInputElement).value);
                                      if (parsed == null) {
                                        props.onRemoveConfigValue([
                                          ...modelPath,
                                          "cost",
                                          "cacheWrite",
                                        ]);
                                        return;
                                      }
                                      props.onSetConfigValue(
                                        [...modelPath, "cost", "cacheWrite"],
                                        parsed,
                                      );
                                    }}
                                  />
                                </label>
                              </div>

                              <div class="llm-model-grid">
                                <label class="field">
                                  <span>Headers (JSON object)</span>
                                  <textarea
                                    rows="3"
                                    .value=${stringifyFieldValue(model.headers)}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = parseJsonObject(
                                        (e.target as HTMLTextAreaElement).value,
                                      );
                                      if (parsed === undefined) {
                                        props.onRemoveConfigValue([...modelPath, "headers"]);
                                        return;
                                      }
                                      if (parsed) {
                                        props.onSetConfigValue([...modelPath, "headers"], parsed);
                                      }
                                    }}
                                  ></textarea>
                                </label>
                                <label class="field">
                                  <span>Compat (JSON object)</span>
                                  <textarea
                                    rows="3"
                                    .value=${stringifyFieldValue(model.compat)}
                                    ?disabled=${disabled}
                                    @change=${(e: Event) => {
                                      const parsed = parseJsonObject(
                                        (e.target as HTMLTextAreaElement).value,
                                      );
                                      if (parsed === undefined) {
                                        props.onRemoveConfigValue([...modelPath, "compat"]);
                                        return;
                                      }
                                      if (parsed) {
                                        props.onSetConfigValue([...modelPath, "compat"], parsed);
                                      }
                                    }}
                                  ></textarea>
                                </label>
                              </div>

                              <div class="row" style="justify-content: flex-end;">
                                <button
                                  class="btn btn--sm danger"
                                  ?disabled=${disabled}
                                  @click=${() =>
                                    props.onSetConfigValue(
                                      [...providerPath, "models"],
                                      models.filter((_, modelIndex) => modelIndex !== index),
                                    )}
                                >
                                  Remove model
                                </button>
                              </div>
                            </div>
                          `;
                        })
                  }
                </div>
              `;
            })
      }

      <div class="llm-divider"></div>

      <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
        <div>
          <div class="card-title">Agent Model Aliases</div>
          <div class="card-sub">Visual CRUD for agents.defaults.models map.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${disabled} @click=${handleAddAlias}>Add alias</button>
      </div>

      ${
        aliasIds.length === 0
          ? html`
              <div class="llm-empty muted">No aliases configured.</div>
            `
          : aliasIds.map((modelRef) => {
              const entry = asRecord(aliases[modelRef]) ?? {};
              const aliasesRecord = { ...aliases };
              const aliasPath: Path = ["agents", "defaults", "models", modelRef];
              return html`
                <div class="llm-alias-row">
                  <label class="field">
                    <span>Model Ref</span>
                    <input
                      .value=${modelRef}
                      ?disabled=${disabled}
                      @change=${(e: Event) => {
                        const nextRef = asTrimmedString((e.target as HTMLInputElement).value);
                        if (
                          !nextRef ||
                          nextRef === modelRef ||
                          aliasesRecord[nextRef] !== undefined
                        ) {
                          return;
                        }
                        const nextAliases = {
                          ...aliasesRecord,
                          [nextRef]: aliasesRecord[modelRef],
                        };
                        delete nextAliases[modelRef];
                        props.onSetConfigValue(["agents", "defaults", "models"], nextAliases);
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Alias</span>
                    <input
                      .value=${asTrimmedString(entry.alias)}
                      ?disabled=${disabled}
                      @input=${(e: Event) => {
                        const nextAlias = (e.target as HTMLInputElement).value;
                        if (nextAlias.trim()) {
                          props.onSetConfigValue([...aliasPath, "alias"], nextAlias);
                          return;
                        }
                        props.onRemoveConfigValue([...aliasPath, "alias"]);
                      }}
                    />
                  </label>
                  <label class="field checkbox">
                    <input
                      type="checkbox"
                      .checked=${asBoolean(entry.streaming)}
                      ?disabled=${disabled}
                      @change=${(e: Event) =>
                        props.onSetConfigValue(
                          [...aliasPath, "streaming"],
                          (e.target as HTMLInputElement).checked,
                        )}
                    />
                    <span>Streaming</span>
                  </label>
                  <label class="field">
                    <span>Params (JSON object)</span>
                    <textarea
                      rows="2"
                      .value=${stringifyFieldValue(entry.params)}
                      ?disabled=${disabled}
                      @change=${(e: Event) => {
                        const parsed = parseJsonObject((e.target as HTMLTextAreaElement).value);
                        if (parsed === undefined) {
                          props.onRemoveConfigValue([...aliasPath, "params"]);
                          return;
                        }
                        if (parsed) {
                          props.onSetConfigValue([...aliasPath, "params"], parsed);
                        }
                      }}
                    ></textarea>
                  </label>
                  <button
                    class="btn btn--sm danger"
                    ?disabled=${disabled}
                    @click=${() => props.onRemoveConfigValue(aliasPath)}
                  >
                    Remove
                  </button>
                </div>
              `;
            })
      }
      ${
        disabled
          ? html`
              <div class="muted llm-footnote">Config is read-only while loading or saving.</div>
            `
          : nothing
      }
    </section>
  `;
}
