import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";

// distinguish subscription authorization from the explicitly selected api billing alternative
export type ModelAuthMode = "codex" | "api";

// reject ambiguous billing configuration before discovering or authenticating any model
export function readModelAuthMode(value: string | undefined): ModelAuthMode {
  if (value === undefined || value === "codex") return "codex";
  if (value === "api") return "api";
  throw new Error("OMP_AUTH_MODE must be codex or api");
}

// explicit runtime paths keep bot credentials separate from developer authentication
export interface ModelConfig {
  agentDir: string;
  authMode?: ModelAuthMode;
  provider?: string;
  modelId?: string;
}

// the resolved catalog entry preserves the actual provider identity throughout generation
export interface ModelRuntime {
  authMode: ModelAuthMode;
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  dispose(): void;
}

// catalog validation prevents implicit replacement with a cheaper or differently named model
export function selectGpt6Model(models: readonly Model<Api>[], provider?: string, modelId?: string): Model<Api> {
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new Error("Set both OMP_MODEL_PROVIDER and OMP_MODEL_ID to an authenticated GPT-6 catalog entry.");
  }
  const candidates = models.filter((model) =>
    /^(?:gpt[- ]6)$/i.test(model.name) || /^gpt-6$/i.test(model.id.split("/").at(-1) ?? ""),
  );
  if (provider && modelId) {
    const model = candidates.find((entry) => entry.provider === provider && entry.id === modelId);
    if (model) return model;
    throw new Error("Configured GPT-6 model is unavailable or unauthenticated. Supply that provider's credentials in the bot runtime and select its exact GPT-6 catalog provider/id using OMP_MODEL_PROVIDER and OMP_MODEL_ID; no fallback is permitted.");
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`Multiple authenticated GPT-6 entries are available: ${candidates.map((model) => `${model.provider}/${model.id}`).join(", ")}. Set OMP_MODEL_PROVIDER and OMP_MODEL_ID explicitly.`);
  }
  throw new Error("No authenticated GPT-6 catalog entry is available for the selected authentication mode. For Codex subscription run bun run login:codex using the bot-owned OMP_AGENT_DIR; for the API alternative explicitly set OMP_AUTH_MODE=api and configure provider credentials. Select only the real GPT-6 provider/id reported by bun scripts/models.ts. Hoplite credentials are not inherited; no model substitution is allowed.");
}

// keep provider selection inside the requested billing route without guessing the model identifier
export function selectModelForAuthMode(models: readonly Model<Api>[], mode: ModelAuthMode, provider?: string, modelId?: string): Model<Api> {
  if (mode === "codex" && provider && provider !== "openai-codex") {
    throw new Error("OMP_AUTH_MODE=codex requires OMP_MODEL_PROVIDER=openai-codex or unset selectors; API access requires explicit OMP_AUTH_MODE=api");
  }
  if (mode === "api" && provider === "openai-codex") throw new Error("Use OMP_AUTH_MODE=codex for subscription access");
  return selectGpt6Model(models.filter(model => mode === "codex"
    ? model.provider === "openai-codex" && model.api === "openai-codex-responses"
    : model.provider !== "openai-codex" && model.api !== "openai-codex-responses"), provider, modelId);
}

// refuse api keys or mixed credential pools in subscription mode instead of silently changing billing routes
export function assertModelAuthentication(auth: AuthStorage, mode: ModelAuthMode, provider: string): void {
  const source = auth.keys.source(provider);
  if (mode === "codex") {
    if (provider !== "openai-codex" || source?.kind !== "oauth" || !auth.credentials.hasOAuth(provider) ||
        auth.credentials.list(provider).some(entry => entry.credential.type !== "oauth")) {
      throw new Error("Codex subscription OAuth is required in the bot-owned OMP_AGENT_DIR. Run bun run login:codex in a private terminal, then restart. API keys and mixed Codex credential pools are refused; there is no API fallback.");
    }
  } else if (provider === "openai-codex" || !source?.concrete || source.kind === "oauth") {
    throw new Error("OMP_AUTH_MODE=api requires an explicit API-key provider credential; use OMP_AUTH_MODE=codex for subscription OAuth");
  }
}

// isolated settings remove ambient memory and auxiliary model activity from conversational sessions
export function conversationalSettings(): Settings {
  return Settings.isolated({
    "memory.backend": "off",
    "autolearn.enabled": false,
    "advisor.enabled": false,
    "prewalk.enabled": false,
    "prewalk.auto": "off",
    "includeWorkspaceTree": false,
    "secrets.enabled": false,
    "compaction.enabled": false,
    "compaction.idleEnabled": false,
    "retry.enabled": false,
    "providers.cacheWarming": "off",
  });
}

// runtime discovery uses only the bot credential database and provider environment variables
export async function resolveModel(config: ModelConfig): Promise<ModelRuntime> {
  const authMode = config.authMode ?? "codex";
  if (authMode === "codex" && config.provider && config.provider !== "openai-codex") {
    throw new Error("Codex mode cannot use an API provider; choose OMP_AUTH_MODE=api explicitly for the alternative");
  }
  await mkdir(config.agentDir, { recursive: true, mode: 0o700 });
  const authStorage = await AuthStorage.create(join(config.agentDir, "agent.db"));
  try {
    await authStorage.credentials.reload();
    if (authMode === "codex") assertModelAuthentication(authStorage, authMode, "openai-codex");
    const modelRegistry = new ModelRegistry(authStorage, join(config.agentDir, "models.yml"), {
      ignoreLocalModelConfig: true,
      settings: conversationalSettings(),
      cacheDbPath: join(config.agentDir, "models.db"),
    });
    await modelRegistry.refresh("online-if-uncached");
    const available = modelRegistry.getAvailable().filter((model) => modelRegistry.hasConcreteAuth(model.provider));
    const eligible = available.filter(model => authMode === "codex" || authStorage.keys.source(model.provider)?.kind !== "oauth");
    const model = selectModelForAuthMode(eligible, authMode, config.provider, config.modelId);
    assertModelAuthentication(authStorage, authMode, model.provider);
    if (!await modelRegistry.getApiKey(model)) {
      throw new Error("The selected GPT-6 provider has no resolvable credential in this bot runtime. Configure its authentication before accepting work.");
    }
    return {
      authMode, model, authStorage, modelRegistry,
      // closing the owned credential database prevents refresh work from surviving shutdown
      dispose: () => authStorage.close(),
    };
  } catch (error) {
    authStorage.close();
    throw error;
  }
}
