import { expect, test } from "bun:test";
import { authentic, createHandler } from "../src/server.ts";

test("HTTP verifies webhook secret before durable acceptance", async () => {
  const updates: number[] = [];
  const handler = createHandler({ secret: "secret", ready: () => true, accept: update => { updates.push(update.update_id); return true; } });
  expect(authentic("wrong", "secret")).toBe(false);
  expect(authentic(null, "secret")).toBe(false);
  const noSecret = await handler(new Request("http://test/telegram/webhook", { method: "POST", body: '{"update_id":1}' }));
  expect(noSecret.status).toBe(401);
  expect(updates).toEqual([]);
  const accepted = await handler(new Request("http://test/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" }, body: '{"update_id":1}' }));
  expect(accepted.status).toBe(200);
  expect(updates).toEqual([1]);
});

test("liveness remains available while readiness and webhook are closed", async () => {
  const handler = createHandler({ secret: "secret", ready: () => false, accept: () => { throw new Error("must not run"); } });
  expect((await handler(new Request("http://test/health"))).status).toBe(200);
  expect((await handler(new Request("http://test/ready"))).status).toBe(503);
  expect((await handler(new Request("http://test/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" } }))).status).toBe(503);
});

test("invalid and oversized updates are not accepted", async () => {
  const handler = createHandler({ secret: "secret", ready: () => true, accept: () => { throw new Error("must not run"); } });
  for (const [body, status] of [["{}", 400], ["not json", 400], ['{"update_id":-1}', 400], ["x".repeat(262145), 413]] as const) {
    expect((await handler(new Request("http://test/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" }, body }))).status).toBe(status);
  }
});
