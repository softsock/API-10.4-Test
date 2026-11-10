import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { readConfig } from "../src/config.ts";
import { Storage } from "../src/storage/index.ts";
import { TelegramApi } from "../src/telegram/api.ts";
import { TelegramBot, type AppUpdate } from "../src/telegram/bot.ts";
import { StreamService } from "../src/agent/stream-service.ts";
import type { AgentSessionService, SessionHandle } from "../src/agent/session-service.ts";
import { sendRenderedResponse } from "../src/rendering/rich-message.ts";

// exercise real grammy routing and telegram transport with only the external model and network replaced
function fixture(adminId = "42", databasePath = ":memory:") {
  const store = new Storage(databasePath);
  const hooks: { beforeEdit?: () => Promise<void>; beforeOpen?: () => Promise<void>; beforePrompt?: () => Promise<void>; abort?: () => void; output?: string; failWidgetAnswer?: boolean } = {};
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const prompts: Array<{ id: string; ephemeral: boolean; text: string }> = [];
  const config = readConfig({ TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_WEBHOOK_SECRET: "s".repeat(32), TELEGRAM_WEBHOOK_URL: "https://bot.example/telegram/webhook", ADMIN_USER_ID: adminId, GUEST_ACCESS_MODE: "owner" });
  const api = new TelegramApi(config.token, { fetch: (async (url: string | URL | Request, options: RequestInit) => {
    const method = String(url).split("/").at(-1)!; const body = JSON.parse(String(options.body));
    calls.push({ method, body });
    if (method === "editMessageWidgetData") await hooks.beforeEdit?.();
    if (method === "answerWidgetQuery" && hooks.failWidgetAnswer) return Response.json({ ok: false, error_code: 400, description: "Query expired" }, { status: 400 });
    return Response.json({ ok: true, result: method === "sendMessage" || method === "sendRichMessage" || method === "sendWidget"
      ? { message_id: 10, chat: { id: Number(body.chat_id ?? 42), type: "private" } } : true });
  }) as unknown as typeof fetch });
  const sessions = { open: async (conversation: { id: string }, ephemeral = false): Promise<SessionHandle> => {
    await hooks.beforeOpen?.();
    return ({
    sessionId: "fixture", sessionPath: undefined, toolNames: [],
    prompt: async (text, delta) => { prompts.push({ id: conversation.id, ephemeral, text }); await hooks.beforePrompt?.(); delta("## Answer\n\n**Generated response**"); return hooks.output ?? "Guest answer"; },
    abort: async () => { hooks.abort?.(); }, dispose: async () => {},
  }); } } as unknown as AgentSessionService;
  let bot: TelegramBot;
  const stream = new StreamService(store, api, conversation => sessions.open({ id: conversation.id }),
    async (conversation, text) => { await sendRenderedResponse(api, { chat_id: conversation.chat_id, message_thread_id: conversation.thread_id || undefined }, text); },
    2, 10000, 1000, id => bot?.refreshWidgets(id));
  bot = new TelegramBot(config, store, stream, sessions, api, "fixture-provider/gpt-6");
  bot.bot.botInfo = { id: 123, is_bot: true, first_name: "Agent", username: "agent_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: true, allows_users_to_create_topics: true, can_manage_bots: false, supports_join_request_queries: false, supports_guest_queries: true };
  const dispatch = async (update: AppUpdate): Promise<void> => {
    store.acceptUpdate(update.update_id, update); store.claimUpdate(update.update_id);
    await bot.bot.handleUpdate(update); store.finishUpdate(update.update_id, "completed");
  };
  const close = async (): Promise<void> => { await bot.shutdown(); await stream.shutdown(); store.close(); };
  return { store, calls, prompts, bot, stream, dispatch, close, hooks, config, sessions, api };
}

// retain real update fields so middleware routing matches telegram's actual webhook contract
function message(updateId: number, text: string, userId = 42, threadId?: number): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1, from: { id: userId, is_bot: false, first_name: "User" },
    chat: { id: userId, type: "private", first_name: "User" }, text, message_thread_id: threadId } };
}

test("personal messages route through isolated topics and finalize as native rich output", async () => {
  const f = fixture();
  try {
    await f.dispatch(message(1, "Hello", 42, 5));
    await f.dispatch(message(2, "Another topic", 42, 6));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]!.id).not.toBe(f.prompts[1]!.id);
    expect(f.calls.filter(call => call.method === "sendRichMessage")).toHaveLength(2);
    expect(f.calls.find(call => call.method === "sendRichMessage")!.body.message_thread_id).toBe(5);
    expect(f.store.getUpdate(1)?.payload).toEqual({});
  } finally { await f.close(); }
});

test("owner-only and non-bot private access is enforced before model work", async () => {
  const f = fixture();
  try {
    await f.dispatch(message(1, "not allowed", 43));
    const group = message(2, "group") as Update;
    group.message!.chat = { id: -1, type: "group", title: "Group" };
    await f.dispatch(group);
    expect(f.prompts).toHaveLength(0);
    await f.dispatch(message(3, "/model"));
    expect(f.calls.at(-1)!.body.text).toBe("fixture-provider/gpt-6");
  } finally { await f.close(); }
});

test("guest dispatch uses one ephemeral context and exactly one inline answer", async () => {
  const f = fixture();
  try {
    const guest = message(1, "@agent_bot question").message!;
    guest.guest_query_id = "guest-1";
    guest.chat = { id: -9, type: "group", title: "External" };
    guest.reply_to_message = { message_id: 5, date: 1, chat: guest.chat, text: "Referenced context", reply_to_message: undefined };
    await f.dispatch({ update_id: 1, guest_message: guest });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.ephemeral).toBe(true);
    expect(f.prompts[0]!.text).toContain("Referenced context");
    expect(f.calls.map(call => call.method)).toEqual(["answerGuestQuery"]);
    expect(f.calls[0]!.body.result.type).toBe("article");
    expect(f.store.getUpdate(1)?.payload).toEqual({});
    const stranger = { ...guest, guest_query_id: "guest-2", from: { id: 43, is_bot: false, first_name: "Other" } };
    await f.dispatch({ update_id: 2, guest_message: stranger });
    expect(f.prompts).toHaveLength(1);
    expect(f.calls.at(-1)!.body.result.input_message_content.message_text).toContain("disabled");
  } finally { await f.close(); }
});

test("widget actions require persisted owner binding and update message-specific data", async () => {
  const f = fixture();
  try {
    await f.dispatch(message(1, "/widget"));
    const conversation = f.store.getOrCreateConversation({ userId: 42, chatId: 42 });
    expect(f.store.getWidget(42, 10)?.conversation_id).toBe(conversation.id);
    const query = { id: "widget-1", from: { id: 43, is_bot: false, first_name: "Other" }, chat: { id: 42, type: "private" as const }, message_id: 10, chat_instance: "test", type: { type: "data" as const }, data: "new" };
    await f.dispatch({ update_id: 2, widget_query: query });
    expect(JSON.parse(f.calls.at(-1)!.body.data).error).toContain("unauthorized");
    await f.dispatch({ update_id: 3, widget_query: { ...query, id: "widget-2", from: { ...query.from, id: 42 }, data: "status" } });
    await Bun.sleep(1);
    const answer = f.calls.find(call => call.method === "answerWidgetQuery" && call.body.widget_query_id === "widget-2");
    expect(JSON.parse(answer!.body.data).model).toBe("fixture-provider/gpt-6");
    expect(f.calls.some(call => call.method === "editMessageWidgetData")).toBe(true);
  } finally { await f.close(); }
});

test("callbacks send user-only ephemeral status and reset requires a one-time owner confirmation", async () => {
  const f = fixture();
  try {
    await f.dispatch(message(1, "/reset"));
    const confirmation = f.calls.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data;
    const callback = { id: "cb-1", from: { id: 42, is_bot: false as const, first_name: "User" }, chat_instance: "test", message: message(10, "controls").message!, data: confirmation };
    await f.dispatch({ update_id: 2, callback_query: callback });
    const ephemeral = f.calls.find(call => call.method === "sendMessage" && call.body.ephemeral_message_parameters);
    expect(ephemeral!.body.chat_id).toBeUndefined();
    expect(ephemeral!.body.ephemeral_message_parameters).toEqual({ callback_query_id: "cb-1" });
    expect(ephemeral!.body.text).toBe("Conversation reset.");
    expect(f.calls.some(call => call.method === "answerCallbackQuery")).toBe(true);
    await f.dispatch({ update_id: 3, callback_query: { ...callback, id: "cb-2" } });
    expect(f.calls.filter(call => call.method === "sendMessage" && call.body.ephemeral_message_parameters).at(-1)!.body.text).toContain("expired");
  } finally { await f.close(); }
});

// deterministic gates expose lifecycle races without introducing artificial provider timing assumptions
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("reset stays fenced while a cancelled session is still opening", async () => {
  const f = fixture(); const opening = gate();
  f.hooks.beforeOpen = () => opening.promise;
  try {
    const request = f.dispatch(message(1, "generate"));
    await Bun.sleep(1);
    await f.dispatch(message(2, "/stop"));
    await f.dispatch(message(3, "/new"));
    expect(f.calls.at(-1)!.body.text).toContain("Stop the active generation");
    opening.resolve(); await request;
    expect(f.prompts).toHaveLength(0);
  } finally { opening.resolve(); await f.close(); }
});

test("widget stop cancels even when acknowledgement fails", async () => {
  const f = fixture(); const prompting = gate(); let aborts = 0;
  f.hooks.beforePrompt = () => prompting.promise;
  f.hooks.abort = () => { aborts++; prompting.resolve(); };
  try {
    await f.dispatch(message(1, "/widget"));
    const request = f.dispatch(message(2, "generate")); await Bun.sleep(1);
    f.hooks.failWidgetAnswer = true;
    await f.dispatch({ update_id: 3, widget_query: { id: "stop", from: { id: 42, is_bot: false, first_name: "Owner" },
      chat: { id: 42, type: "private" }, message_id: 10, chat_instance: "test", type: { type: "data" }, data: "stop" } });
    await request;
    expect(aborts).toBe(1);
    expect(f.calls.some(call => call.method === "sendRichMessage")).toBe(false);
  } finally { prompting.resolve(); await f.close(); }
});

test("shutdown prevents a guest prompt whose session was still opening", async () => {
  const f = fixture(); const opening = gate(); f.hooks.beforeOpen = () => opening.promise;
  try {
    const guest = message(1, "guest").message!; guest.guest_query_id = "closing";
    const request = f.dispatch({ update_id: 1, guest_message: guest }); await Bun.sleep(1);
    await f.bot.shutdown(); opening.resolve(); await request;
    expect(f.prompts).toHaveLength(0);
    expect(f.calls.find(call => call.method === "answerGuestQuery")!.body.result.input_message_content.message_text).toContain("shutting down");
  } finally { opening.resolve(); await f.close(); }
});

test("guest unicode output remains inside the transport limit and repeated widget commands reuse one binding", async () => {
  const f = fixture(); f.hooks.output = "🙂".repeat(5000);
  try {
    const guest = message(1, "guest").message!; guest.guest_query_id = "emoji";
    await f.dispatch({ update_id: 1, guest_message: guest });
    const text = f.calls.find(call => call.method === "answerGuestQuery")!.body.result.input_message_content.message_text;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
    await f.dispatch(message(2, "/widget")); await f.dispatch(message(3, "/widget"));
    expect(f.calls.filter(call => call.method === "sendWidget")).toHaveLength(1);
    expect(f.store.getWidgets(f.store.getOrCreateConversation({ userId: 42, chatId: 42 }).id)).toHaveLength(1);
  } finally { await f.close(); }
});

test("reused widget refreshes serialize with generation transitions and never share a revision", async () => {
  const f = fixture(); const editing = gate(); let first = true;
  f.hooks.beforeEdit = async () => { if (first) { first = false; await editing.promise; } };
  try {
    await f.dispatch(message(1, "/widget"));
    await f.dispatch(message(2, "generate"));
    const reused = f.dispatch(message(3, "/widget"));
    await Bun.sleep(1); editing.resolve(); await reused;
    const states = f.calls.filter(call => call.method === "editMessageWidgetData").map(call => JSON.parse(call.body.chat_data));
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(new Set(states.map(state => state.revision)).size).toBe(states.length);
    expect(states.at(-1)!.status).toBe("completed");
    expect(f.calls.filter(call => call.method === "sendWidget")).toHaveLength(1);
  } finally { editing.resolve(); await f.close(); }
});

// the first valid private claim wins before any await and cannot be replaced by a concurrent claimant
test("first private /stast establishes owner atomically and only the winner can generate", async () => {
  const f = fixture("");
  try {
    await f.dispatch(message(1, "no owner yet", 43));
    expect(f.prompts).toHaveLength(0);
    await Promise.all([f.dispatch(message(2, "/stast", 42)), f.dispatch(message(3, "/stast", 43))]);
    expect(f.store.getOwnerId()).toBe(42);
    expect(f.calls.filter(call => call.body.text?.includes("now the bot owner"))).toHaveLength(1);
    await f.dispatch(message(4, "allowed", 42));
    await f.dispatch(message(5, "denied", 43));
    expect(f.prompts).toHaveLength(1);
    await f.dispatch(message(6, "/reset", 42));
    expect(f.store.getOwnerId()).toBe(42);
  } finally { await f.close(); }
});

// commands addressed to another bot, group messages and bot accounts must never gain privileged ownership
test("/stast claims require a real user in private chat and the correct bot mention", async () => {
  const f = fixture("");
  try {
    const group = message(1, "/stast"); group.message!.chat = { id: -1, type: "group", title: "Group" };
    await f.dispatch(group);
    const robot = message(2, "/stast"); robot.message!.from!.is_bot = true;
    await f.dispatch(robot);
    await f.dispatch(message(3, "/stast@other_bot"));
    const guest = message(4, "/stast").message!; guest.guest_query_id = "no-owner-claim";
    await f.dispatch({ update_id: 4, guest_message: guest });
    expect(f.store.getOwnerId()).toBeUndefined();
    await f.dispatch(message(5, "/stast@agent_bot"));
    expect(f.store.getOwnerId()).toBe(42);
    await f.dispatch(message(6, "/stast"));
    expect(f.calls.at(-1)!.body.text).toContain("already the bot owner");
  } finally { await f.close(); }
});

// an explicitly configured administrator is reserved before any stranger can attempt the bootstrap command
test("configured admin reserves durable ownership and cannot be claimed by another user", async () => {
  const f = fixture();
  try {
    expect(f.store.getOwnerId()).toBe(42);
    await f.dispatch(message(1, "/stast", 43));
    expect(f.store.getOwnerId()).toBe(42);
    expect(f.calls.at(-1)!.body.text).toContain("already has an owner");
  } finally { await f.close(); }
});

// a fresh process must honor the original claim and fail closed on conflicting environment ownership
test("claimed ownership survives bot recreation and refuses conflicting admin configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-owner-"));
  const path = join(directory, "app.sqlite");
  let current = fixture("", path);
  try {
    await current.dispatch(message(1, "/stast", 42));
    await current.close();
    current = fixture("", path);
    expect(current.store.getOwnerId()).toBe(42);
    await current.dispatch(message(2, "/stast", 43));
    await current.dispatch(message(3, "still owner", 42));
    await current.dispatch(message(4, "still denied", 43));
    expect(current.prompts).toHaveLength(1);
    expect(() => new TelegramBot({ ...current.config, adminId: 43 }, current.store, current.stream,
      current.sessions, current.api, "fixture-provider/gpt-6")).toThrow("conflicts with the persisted bot owner");
    expect(current.store.getOwnerId()).toBe(42);
  } finally { await current.close(); rmSync(directory, { recursive: true, force: true }); }
});

// the persisted winner must receive the same widget callback and guest permissions as a configured owner
test("claimed owner can use widgets ephemeral callbacks and owner-authorized guest mode", async () => {
  const f = fixture("");
  try {
    await f.dispatch(message(1, "/stast", 42));
    await f.dispatch(message(2, "/widget", 42));
    await f.dispatch({ update_id: 3, widget_query: { id: "claimed-widget", from: { id: 42, is_bot: false, first_name: "Owner" },
      chat: { id: 42, type: "private" }, message_id: 10, chat_instance: "test", type: { type: "data" }, data: "status" } });
    const answer = f.calls.find(call => call.method === "answerWidgetQuery" && call.body.widget_query_id === "claimed-widget");
    expect(JSON.parse(answer!.body.data).model).toBe("fixture-provider/gpt-6");
    await f.dispatch({ update_id: 4, callback_query: { id: "claimed-callback", from: { id: 42, is_bot: false, first_name: "Owner" },
      chat_instance: "test", message: message(10, "controls").message!, data: "status" } });
    expect(f.calls.find(call => call.body.ephemeral_message_parameters?.callback_query_id === "claimed-callback")!.body.text).toContain("Model: fixture-provider/gpt-6");
    const guest = message(5, "guest", 42).message!; guest.guest_query_id = "claimed-guest";
    await f.dispatch({ update_id: 5, guest_message: guest });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.ephemeral).toBe(true);
    await f.dispatch(message(6, "/new", 42));
    expect(f.store.getOwnerId()).toBe(42);
  } finally { await f.close(); }
});
