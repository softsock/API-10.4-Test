import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { assertModelAuthentication, conversationalSettings, readModelAuthMode, selectModelForAuthMode } from "../src/agent/model-service.ts";

// expose only bot-owned authenticated catalog identities so operators never need to guess a model identifier
async function listModels(): Promise<void> {
  const authMode = readModelAuthMode(process.env.OMP_AUTH_MODE);
  const agentDir = resolve(process.env.OMP_AGENT_DIR ?? "/data/omp/agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const auth = await AuthStorage.create(join(agentDir, "agent.db"));
  try {
    await auth.credentials.reload();
    const registry = new ModelRegistry(auth, join(agentDir, "models.yml"), { ignoreLocalModelConfig: true,
      settings: conversationalSettings(), cacheDbPath: join(agentDir, "models.db") });
    await registry.refresh("online-if-uncached");
    const models = registry.getAvailable().filter(model => registry.hasConcreteAuth(model.provider));
    console.log(JSON.stringify({ authMode, authenticatedModels: models.map(model => ({ provider: model.provider, id: model.id, name: model.name })) }, null, 2));
    try {
      const eligible = models.filter(model => authMode === "codex" || auth.keys.source(model.provider)?.kind !== "oauth");
      const selected = selectModelForAuthMode(eligible, authMode, process.env.OMP_MODEL_PROVIDER, process.env.OMP_MODEL_ID);
      assertModelAuthentication(auth, authMode, selected.provider);
      console.log(JSON.stringify({ selected: { provider: selected.provider, id: selected.id }, authentication: "catalog only; startup performs an independent real prompt" }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "GPT-6 model configuration failed");
      process.exitCode = 1;
    }
  } finally { auth.close(); }
}

await listModels();
