import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { loginCodex, type CodexLoginAuth, type CodexLoginOptions } from "../src/agent/codex-login.ts";

const directories: string[] = [];

// temporary bot databases must not survive authentication tests
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bot-codex-"));
  directories.push(path);
  return path;
}

// only bot-owned fixtures are removed after each offline authentication check
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

// a minimal fake preserves the real login signature without invoking a provider
async function fixture(login?: CodexLoginAuth["oauth"]["login"]): Promise<{
  options: CodexLoginOptions; output: string[]; paths: string[]; closed: () => number;
}> {
  const output: string[] = [];
  const paths: string[] = [];
  let closes = 0;
  return {
    output, paths,
    // shutdown counts expose database leaks on every completion path
    closed: () => closes,
    options: {
      agentDir: await directory(),
      ui: { inputIsTTY: true, outputIsTTY: true,
        // captured tty output permits assertions without printing device challenges
        write(text) { output.push(text); },
      },
      // the injected storage records the exact credential path selected by the command
      async createAuth(path) {
        paths.push(path);
        let loaded = false;
        return {
          credentials: {
            // existing credentials must be loaded before login can update the bot account pool
            async reload() { loaded = true; },
          },
          oauth: {
            // mocked authorization enforces the same pool initialization order as the real sdk
            async login(provider, controller) {
              expect(loaded).toBe(true);
              return login ? login(provider, controller) : { type: "oauth" };
            },
          },
          // each opened fake database must be closed even when authorization fails
          close() { closes++; },
        };
      },
    },
  };
}

// login safety checks exercise both mocked failures and real isolated credential persistence
describe("isolated Codex subscription login", () => {
  // the device alias and controller callbacks are required by the installed sdk contract
  test("uses device OAuth and prints challenges only through the terminal UI", async () => {
    const item = await fixture(async (provider, ctrl) => {
      expect(provider).toBe("openai-codex-device");
      expect(ctrl.signal).toBeInstanceOf(AbortSignal);
      expect(ctrl.onPrompt).toBeFunction();
      expect(ctrl.onManualCodeInput).toBeUndefined();
      expect(ctrl.onBrowserSession).toBeUndefined();
      ctrl.onAuth({ url: "https://auth.openai.com/codex/device", instructions: "Enter code: TEST-CODE" });
      ctrl.onProgress?.("provider message containing secret-token");
      return { type: "oauth", email: "not-for-logs@example.test" };
    });
    await loginCodex(item.options);
    expect(item.paths).toEqual([join(item.options.agentDir, "agent.db")]);
    expect(item.output.join("")).toContain("Enter code: TEST-CODE");
    expect(item.output.join("")).not.toContain("secret-token");
    expect(item.output.join("")).not.toContain("not-for-logs");
    expect(item.closed()).toBe(1);
  });

  // redirected input or output must fail before storage or provider work begins
  test.each([[false, true], [true, false], [false, false]])("rejects non-TTY input/output %s/%s", async (inputIsTTY, outputIsTTY) => {
    const item = await fixture();
    Object.assign(item.options.ui, { inputIsTTY, outputIsTTY });
    await expect(loginCodex(item.options)).rejects.toThrow("interactive local terminal");
    expect(item.paths).toHaveLength(0);
    expect(item.output).toHaveLength(0);
  });

  // unexpected prompts must never become password or callback collectors
  test.each([false, true])("rejects unexpected prompts including masked=%s", async secret => {
    const item = await fixture(async (_provider, ctrl) => {
      await ctrl.onPrompt({ message: "sensitive provider prompt", secret });
      return { type: "oauth" };
    });
    await expect(loginCodex(item.options)).rejects.toThrow("login failed");
    expect(item.output.join("")).not.toContain("sensitive");
    expect(item.closed()).toBe(1);
  });

  // provider responses must not redirect the operator to an untrusted authorization page
  test("rejects unexpected authorization instructions", async () => {
    const item = await fixture(async (_provider, ctrl) => {
      ctrl.onAuth({ url: "https://unexpected.example.test", instructions: "Enter code: TEST-CODE" });
      return { type: "oauth" };
    });
    await expect(loginCodex(item.options)).rejects.toThrow("login failed");
    expect(item.output).toHaveLength(0);
    expect(item.closed()).toBe(1);
  });

  // login success must mean a durable OAuth grant rather than API-key fallback or no credential
  test.each([undefined, { type: "api_key" as const }])("rejects non-OAuth identity %j", async identity => {
    const item = await fixture(async () => identity);
    await expect(loginCodex(item.options)).rejects.toThrow("login failed");
    expect(item.closed()).toBe(1);
  });

  // raw upstream errors can contain tokens and therefore cannot cross the reusable login boundary
  test("redacts provider failures and closes the database", async () => {
    const item = await fixture(async () => { throw new Error("secret-refresh-token"); });
    await expect(loginCodex(item.options)).rejects.toThrow("Codex subscription login failed");
    expect(item.output.join("")).not.toContain("secret-refresh-token");
    expect(item.closed()).toBe(1);
  });

  // existing deployments need private permissions too rather than only freshly created directories
  test("enforces private directory and database permissions", async () => {
    const item = await fixture();
    await chmod(item.options.agentDir, 0o755);
    await writeFile(join(item.options.agentDir, "agent.db"), "", { mode: 0o644 });
    await loginCodex(item.options);
    expect((await stat(item.options.agentDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(item.options.agentDir, "agent.db"))).mode & 0o777).toBe(0o600);
  });

  // omitted or relative storage paths must never select ambient developer authentication
  test.each(["", "relative/agent"])("rejects non-explicit directory %j", async agentDir => {
    const item = await fixture();
    await expect(loginCodex({ ...item.options, agentDir })).rejects.toThrow("explicit absolute");
    expect(item.paths).toHaveLength(0);
  });

  // personal agent stores are rejected before their contents or permissions can be accessed
  test.each([homedir(), join(homedir(), ".codex"), join(homedir(), ".omp", "agent"), "/"])("rejects personal storage %s", async agentDir => {
    const item = await fixture();
    await expect(loginCodex({ ...item.options, agentDir })).rejects.toThrow("dedicated bot directory");
    expect(item.paths).toHaveLength(0);
  });

  // linked databases must never expose credentials owned by another runtime
  test("rejects linked database and directory without touching their targets", async () => {
    const item = await fixture();
    const target = join(await directory(), "unrelated.db");
    await writeFile(target, "do not read or change", { mode: 0o644 });
    await symlink(target, join(item.options.agentDir, "agent.db"));
    await expect(loginCodex(item.options)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("do not read or change");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    const linked = join(await directory(), "linked");
    await symlink(item.options.agentDir, linked);
    await expect(loginCodex({ ...item.options, agentDir: linked })).rejects.toThrow("symlinks");
    expect(item.paths).toHaveLength(0);
  });

  // cancellation before login must not open a database or make provider requests
  test("honors an already aborted signal", async () => {
    const item = await fixture();
    await expect(loginCodex({ ...item.options, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(item.paths).toHaveLength(0);
  });

  // cancellation and deadlines must reach the controller and close storage after provider settlement
  test.each(["cancel", "timeout"])("handles %s while awaiting authorization", async mode => {
    const controller = new AbortController();
    const item = await fixture(async (_provider, ctrl) => {
      const signal = ctrl.signal!;
      if (mode === "cancel") controller.abort();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("cancelled"));
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      return { type: "oauth" };
    });
    await expect(loginCodex({ ...item.options, signal: controller.signal, timeoutMs: 20 })).rejects.toThrow("cancelled or timed out");
    expect(item.closed()).toBe(1);
  });

  // the executable must refuse deployment-style execution before creating files or initiating OAuth
  test("command refuses non-interactive execution", async () => {
    const agentDir = join(await directory(), "not-created");
    const child = Bun.spawn([process.execPath, "scripts/login-codex.ts"], {
      cwd: process.cwd(), env: { ...process.env, OMP_AGENT_DIR: agentDir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toContain("interactive local terminal");
    await expect(lstat(agentDir)).rejects.toThrow();
  });

  // real sdk storage proves alias persistence and refresh without any live provider requests
  test("persists device OAuth as openai-codex in the explicit database and reopens it", async () => {
    const agentDir = await directory();
    const requests: string[] = [];
    const access = `fixture.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "bot-test-account" },
    })).toString("base64url")}.signature`;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: URL | RequestInfo) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        return Response.json({ device_auth_id: "synthetic-device-id", user_code: "TEST-CODE", interval: 1 });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        return Response.json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" });
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 });
      }
      throw new Error("Unexpected network request blocked by offline test");
    }) as typeof fetch);
    try {
      await loginCodex({ agentDir,
        ui: { inputIsTTY: true, outputIsTTY: true,
          // integration challenges stay in memory and never reach test-runner output
          write() {},
        },
      });
      const auth = await AuthStorage.create(join(agentDir, "agent.db"), {
        // account selection remains offline while exercising real refresh resolution
        usageProviderResolver: () => undefined,
        // deterministic refresh proves oauth.access owns token renewal without provider traffic
        async refreshOAuthCredential(provider, _id, credential) {
          expect(provider).toBe("openai-codex");
          return { ...credential, access: "synthetic-refreshed-access", expires: Date.now() + 3600000 };
        },
      });
      try {
        await auth.credentials.reload();
        expect(auth.credentials.get("openai-codex")?.type).toBe("oauth");
        expect(auth.credentials.get("openai-codex-device")).toBeUndefined();
        expect(auth.oauth.accounts("openai-codex")[0]?.accountId).toBe("bot-test-account");
        const resolved = await auth.oauth.access("openai-codex", undefined, { forceRefresh: true });
        expect(resolved?.accessToken).toBe("synthetic-refreshed-access");
        expect(resolved?.accountId).toBe("bot-test-account");
      } finally {
        auth.close();
      }
      expect(requests).toEqual([
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        "https://auth.openai.com/api/accounts/deviceauth/token",
        "https://auth.openai.com/oauth/token",
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  }, 15000);
});
