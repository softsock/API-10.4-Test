import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";

// explicit runtime paths keep bot credentials separate from developer authentication
export interface ModelConfig {
  agentDir: string;
  provider?: string;
  modelId?: string;
}

// the resolved catalog entry preserves the actual provider identity throughout generation
export interface ModelRuntime {
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
  throw new Error("No authenticated GPT-6 catalog entry is available. Configure the actual GPT-6 provider credentials in Railway (for OpenAI API access: OPENAI_API_KEY), or provision OMP OAuth in OMP_AGENT_DIR/agent.db, then set OMP_MODEL_PROVIDER and OMP_MODEL_ID to its exact catalog entry. Hoplite credentials are not inherited; no model substitution is allowed.");
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
  await mkdir(config.agentDir, { recursive: true, mode: 0o700 });
  const authStorage = await AuthStorage.create(join(config.agentDir, "agent.db"));
  try {
    const modelRegistry = new ModelRegistry(authStorage, join(config.agentDir, "models.yml"), {
      ignoreLocalModelConfig: true,
      settings: conversationalSettings(),
      cacheDbPath: join(config.agentDir, "models.db"),
    });
    await modelRegistry.refresh("online-if-uncached");
    const available = modelRegistry.getAvailable().filter((model) => modelRegistry.hasConcreteAuth(model.provider));
    const model = selectGpt6Model(available, config.provider, config.modelId);
    if (!await modelRegistry.getApiKey(model)) {
      throw new Error("The selected GPT-6 provider has no resolvable credential in this bot runtime. Configure its authentication before accepting work.");
    }
    return {
      model, authStorage, modelRegistry,
      // closing the owned credential database prevents refresh work from surviving shutdown
      dispose: () => authStorage.close(),
    };
  } catch (error) {
    authStorage.close();
    throw error;
  }
}
