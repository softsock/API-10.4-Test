import { loginCodex } from "../src/agent/codex-login.ts";

// an explicit terminal command prevents login challenges from entering the bot or deployment logs
async function main(): Promise<void> {
  const controller = new AbortController();
  // terminal shutdown must cancel device polling without leaving the credential database open
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await loginCodex({
      agentDir: process.env.OMP_AGENT_DIR ?? "/data/omp/agent",
      signal: controller.signal,
      ui: {
        inputIsTTY: process.stdin.isTTY === true,
        outputIsTTY: process.stdout.isTTY === true,
        // stdout is the checked local tty and is never replaced with a logger
        write(text) { process.stdout.write(text); },
      },
    });
  } catch {
    process.stderr.write("Codex login did not complete. Use a private interactive local terminal with a dedicated absolute OMP_AGENT_DIR; do not redirect output or paste secrets.\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) await main();
