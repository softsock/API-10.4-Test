import { expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import { authorized, RateLimiter } from "../src/telegram/access.ts";

const env = { TELEGRAM_BOT_TOKEN: "test", TELEGRAM_WEBHOOK_SECRET: "x".repeat(32), TELEGRAM_WEBHOOK_URL: "https://bot.example/telegram/webhook", ADMIN_USER_ID: "42" };

test("configuration denies unsafe secrets, missing credentials and ephemeral storage", () => {
  expect(() => readConfig({})).toThrow("TELEGRAM_BOT_TOKEN");
  expect(() => readConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow();
  expect(() => readConfig({ ...env, DATABASE_PATH: "/tmp/app.sqlite" })).toThrow();
  expect(() => readConfig({ ...env, TELEGRAM_WEBHOOK_URL: "http://bot.example/telegram/webhook" })).toThrow();
  expect(readConfig(env).port).toBe(3000);
});

test("owner-only is default with independent guest policy", () => {
  const config = readConfig(env);
  expect(authorized(config, 42)).toBe(true);
  expect(authorized(config, 43)).toBe(false);
  expect(authorized(config, 42, true)).toBe(false);
  expect(authorized({ ...config, guestAccess: "public" }, 43, true)).toBe(true);
});

test("rate limiter bounds bursts and releases expired budgets", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now, 2);
  expect(limiter.allow(1)).toBe(true);
  expect(limiter.allow(1)).toBe(true);
  expect(limiter.allow(1)).toBe(false);
  expect(limiter.allow(2)).toBe(true);
  now = 60001;
  expect(limiter.allow(1)).toBe(true);
});

// unconfigured ownership must not accidentally make either private or guest generation public
test("an unset admin allows one-time bootstrap but denies access until an owner is persisted", () => {
  const config = readConfig({ ...env, ADMIN_USER_ID: "" });
  expect(config.adminId).toBeUndefined();
  expect(authorized(config, 42)).toBe(false);
  expect(authorized({ ...config, accessMode: "public", guestAccess: "public" }, 42)).toBe(false);
  expect(authorized({ ...config, guestAccess: "public" }, 42, true)).toBe(false);
  expect(authorized(config, 42, false, 42)).toBe(true);
  expect(authorized(config, 43, false, 42)).toBe(false);
  expect(authorized({ ...config, guestAccess: "owner" }, 42, true, 42)).toBe(true);
  for (const ADMIN_USER_ID of ["0", "-1", "invalid", "1.5", "9007199254740992"]) {
    expect(() => readConfig({ ...env, ADMIN_USER_ID })).toThrow("ADMIN_USER_ID");
  }
});

// the subscription route is the default even when an api credential happens to exist in the environment
test("authentication mode defaults to Codex and API use requires an explicit opt-in", () => {
  expect(readConfig(env).authMode).toBe("codex");
  expect(readConfig({ ...env, OPENAI_API_KEY: "fixture-not-a-credential" }).authMode).toBe("codex");
  expect(readConfig({ ...env, OMP_AUTH_MODE: "api", OMP_MODEL_PROVIDER: "openai", OMP_MODEL_ID: "gpt-6" }).authMode).toBe("api");
  expect(() => readConfig({ ...env, OMP_AUTH_MODE: "automatic" })).toThrow("OMP_AUTH_MODE");
  expect(() => readConfig({ ...env, OMP_MODEL_PROVIDER: "openai", OMP_MODEL_ID: "gpt-6" })).toThrow("OMP_AUTH_MODE=api");
});
