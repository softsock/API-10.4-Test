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
