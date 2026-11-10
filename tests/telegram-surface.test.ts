import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { TelegramApi, TelegramApiError, validateRichMessage, validateWidgetHtml } from "../src/telegram/api";
import { renderRichMessage, sendRenderedResponse, splitPlainText } from "../src/rendering/rich-message";
import { AGENT_CONTROL_HTML, authorizeWidgetQuery, createAgentControlWidget, encodeAgentControlState } from "../src/widgets/agent-control";
import type { AgentControlState } from "../src/widgets/agent-control";
import type { WidgetQuery } from "../src/telegram/types";

// isolated mock transport records payloads without ever contacting telegram
function mockApi(responses: Array<Response | Error>) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const waits: number[] = [];
  const api = new TelegramApi("123:test", {
    // deterministic transport distinguishes explicit rejection from uncertain network delivery
    fetch: (async (url, options) => {
      calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(options!.body as string) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("Unexpected request");
      return next;
    }) as typeof fetch,
    // injected sleep makes retry-after verification immediate and reproducible
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  return { api, calls, waits };
}

// telegram envelopes keep mocked success and rejection shapes faithful to the actual protocol
function envelope(result: unknown, status = 200): Response {
  return Response.json(status === 200 ? { ok: true, result } : result, { status });
}

// a representative private widget state contains no inferred usage or provider credentials
function state(overrides: Partial<AgentControlState> = {}): AgentControlState {
  return { revision: 1, agent: "Assistant", status: "idle", model: "provider/actual-model", operation: "Ready", ...overrides };
}

// authorized message coordinates stand in for the parent's persistent widget ownership lookup
function query(overrides: Partial<WidgetQuery> = {}): WidgetQuery {
  return { id: "q", from: { id: 7, is_bot: false, first_name: "User" }, chat: { id: 7, type: "private" }, message_id: 9, chat_instance: "chat", type: { type: "data" }, data: "stop", ...overrides };
}

// a tiny quickjs-compatible dom harness verifies widget behavior without claiming native telegram rendering
function widgetHarness(initial: AgentControlState) {
  const elements: Record<string, { textContent: string; disabled: boolean; onclick?: () => void }> = {};
  const events: Record<string, () => void> = {};
  const actions: string[] = [];
  let resolve: ((value: unknown) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const widget = {
    chatData: encodeAgentControlState(initial), chatType: "private", viewer: { id: 7 }, isPreview: false, isForward: false,
    // widget state changes must be explicit events rather than accidental promise mutation
    onEvent: (name: string, callback: () => void) => { events[name] = callback; },
    // ready is a supported optional lifecycle signal rather than a browser load event
    ready: () => {},
    // controllable answers exercise both optimistic response reconciliation and native state updates
    request: (action: string) => {
      actions.push(action);
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    },
  };
  const script = AGENT_CONTROL_HTML.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(script, {
    window: { TelegramWidget: widget },
    document: {
      // text content and disabled state are enough to exercise the widget's trusted rendering boundary
      getElementById: (id: string) => elements[id] ??= { textContent: "", disabled: false },
    },
    // clock rendering is deterministic here and does not need background timers
    setInterval: () => 1,
  });
  return { elements, events, actions, widget,
    // backend answer delivery stays separate from message state publication
    answer: (value: unknown) => resolve!({ result: JSON.stringify(value) }),
    // protocol failures must remain visible to the user
    fail: (code: string) => reject!({ code }),
  };
}

describe("Telegram 10.4 transport", () => {
  test("retries only explicit 429 with retry-after", async () => {
    const { api, calls, waits } = mockApi([
      envelope({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } }, 429),
      envelope({ message_id: 1, chat: { id: 7, type: "private" } }),
    ]);
    await api.sendMessage({ chat_id: 7, text: "hello" });
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
  });

  test("never retries ambiguous sends or server errors", async () => {
    for (const failure of [new Error("network https://api.telegram.org/bot123:test"), new Response("broken", { status: 502 }), envelope({ ok: false, error_code: 500, description: "Server error" }, 500)]) {
      const { api, calls } = mockApi([failure]);
      await expect(api.sendMessage({ chat_id: 7, text: "hello" })).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });

  test("transport errors do not disclose the token", async () => {
    const { api } = mockApi([new Error("secret transport URL bot123:test")]);
    await expect(api.sendMessage({ chat_id: 7, text: "hello" })).rejects.toThrow("delivery unknown");
  });

  test("widget answers never wait past the fifteen-second protocol deadline", async () => {
    const { api, calls, waits } = mockApi([envelope({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 15 } }, 429)]);
    await expect(api.answerWidgetQuery({ widget_query_id: "q", data: "{}" })).rejects.toBeInstanceOf(TelegramApiError);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("empty thinking drafts and stable cancellation identifiers use native fields", async () => {
    const { api, calls } = mockApi([envelope(true), envelope(true), envelope(true)]);
    await api.sendMessageDraft({ chat_id: 7, draft_id: 22, text: "", can_stop: true, keep_on_stop: true });
    await api.sendMessageDraft({ chat_id: 7, draft_id: 22, text: "**incomplete", can_stop: true });
    await api.sendRichMessageDraft({ chat_id: 7, draft_id: 22, rich_message: { markdown: "complete" } });
    expect(calls[0]!.body).toMatchObject({ text: "", can_stop: true, keep_on_stop: true });
    expect(calls[1]!.body.draft_id).toBe(22);
    expect(calls[1]!.body).not.toHaveProperty("parse_mode");
    expect(calls[2]!.method).toBe("sendRichMessageDraft");
    expect(() => api.sendMessageDraft({ chat_id: 7, draft_id: 0 })).toThrow();
  });

  test("cancellation prevents a rate-limited draft from being resent after stop", async () => {
    const controller = new AbortController();
    let requests = 0;
    const api = new TelegramApi("123:test", {
      // this explicit rejection permits retry only while the owning generation remains active
      fetch: (async (_url, _options) => {
        requests++;
        return envelope({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429);
      }) as typeof fetch,
      // stopping during the wait must win over the already scheduled retry
      sleep: async () => { controller.abort(); },
    });
    await expect(api.sendMessageDraft({ chat_id: 7, draft_id: 9, text: "partial" }, controller.signal)).rejects.toThrow("cancelled");
    expect(requests).toBe(1);
  });

  test("guest answers contain one article and return the official inline identifier", async () => {
    const { api, calls } = mockApi([envelope({ inline_message_id: "inline" })]);
    expect(await api.answerGuestQuery({ guest_query_id: "guest", result: { type: "article", id: "one", title: "Answer", input_message_content: { message_text: "Hello" } } })).toEqual({ inline_message_id: "inline" });
    expect(calls[0]!.body).not.toHaveProperty("results");
  });

  test("ephemeral replies omit chat and receiver and always acknowledge callbacks", async () => {
    const { api, calls } = mockApi([envelope(true), envelope({ message_id: 1, chat: { id: 7, type: "private" } })]);
    await api.sendEphemeralReply("callback", "Private status");
    expect(calls[1]!.body).toEqual({ text: "Private status", ephemeral_message_parameters: { callback_query_id: "callback" } });
    expect(calls[0]!.method).toBe("answerCallbackQuery");
    const failing = mockApi([envelope(true), envelope({ ok: false, error_code: 400, description: "Expired" }, 400)]);
    await expect(failing.api.sendEphemeralReply("old", "Status")).rejects.toBeInstanceOf(TelegramApiError);
    expect(failing.calls[0]!.method).toBe("answerCallbackQuery");
  });
});

describe("rich output", () => {
  test("rich content exclusivity and source limits are validated before delivery", () => {
    expect(() => validateRichMessage({ html: "<p>Hello</p>" })).not.toThrow();
    for (const invalid of [{}, { html: "x", markdown: "y" }, { markdown: " " }, { markdown: "x".repeat(32769) }]) {
      expect(() => validateRichMessage(invalid)).toThrow();
    }
  });

  test("renders generated-style headings tables links lists quotes and fenced source as official rich markdown", () => {
    const answer = '# Analysis\n\n**Result** and *detail*, `x`.\n\n| Name | Value |\n| --- | --- |\n| a | 2 |\n\n- Item\n\n> Evidence\n\n[Reference](https://example.com)\n\n---\n\n```typescript\nconst x = 2;\n```';
    expect(renderRichMessage(answer)).toEqual([{ kind: "rich", rich_message: { markdown: answer, skip_entity_detection: true } }]);
  });

  test("untrusted media html protocols and malformed fences use literal plain fallback", () => {
    for (const answer of ['![media](https://example.com/x)', '<script>alert(1)</script>', '[link](javascript:bad)', '```ts\nunclosed']) {
      expect(renderRichMessage(answer)[0]!.kind).toBe("plain");
    }
    expect(renderRichMessage("\u0000hello")[0]).toMatchObject({ rich_message: { markdown: "hello" } });
    expect(renderRichMessage(" ")).toEqual([]);
  });

  test("oversized fenced responses are lossless plain chunks with no broken unicode", () => {
    const answer = '```text\n' + '🙂abc\n'.repeat(5000) + '```';
    const chunks = splitPlainText(answer);
    expect(chunks.join("")).toBe(answer);
    expect(chunks.every((chunk) => chunk.length <= 4096 && !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
    expect(renderRichMessage(answer).every((part) => part.kind === "plain")).toBe(true);
  });

  test("definite parse rejection falls back but ambiguous delivery never duplicates", async () => {
    const ok = { message_id: 1, chat: { id: 7, type: "private" } };
    const { api, calls } = mockApi([envelope({ ok: false, error_code: 400, description: "Can't parse rich message" }, 400), envelope(ok)]);
    await sendRenderedResponse(api, { chat_id: 7 }, "**answer**");
    expect(calls.map((call) => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
    const failed = mockApi([new Error("network")]);
    await expect(sendRenderedResponse(failed.api, { chat_id: 7 }, "answer")).rejects.toThrow();
    expect(failed.calls).toHaveLength(1);
    const missingChat = mockApi([envelope({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400)]);
    await expect(sendRenderedResponse(missingChat.api, { chat_id: 7 }, "answer")).rejects.toBeInstanceOf(TelegramApiError);
    expect(missingChat.calls).toHaveLength(1);
  });
});

describe("Agent Control widget", () => {
  test("html fits official raw and compressed limits without external dependencies", () => {
    expect(Buffer.byteLength(AGENT_CONTROL_HTML)).toBeLessThanOrEqual(32768);
    expect(deflateSync(AGENT_CONTROL_HTML, { level: 9 }).length).toBeLessThan(3900);
    expect(() => validateWidgetHtml(AGENT_CONTROL_HTML)).not.toThrow();
    expect(AGENT_CONTROL_HTML).not.toMatch(/fetch\(|XMLHttpRequest|<script[^>]+src|https?:\/\//);
    expect(() => validateWidgetHtml("x".repeat(32769))).toThrow();
    const incompressible = Buffer.from(crypto.getRandomValues(new Uint8Array(12000))).toString("base64");
    expect(() => validateWidgetHtml(incompressible)).toThrow("compressed");
  });

  test("construction uses private message state and opt-in queries", () => {
    const payload = createAgentControlWidget({ id: 7, type: "private" }, state(), 3);
    expect(payload).toMatchObject({ chat_id: 7, message_thread_id: 3, allow_queries: true, is_shared: false });
    expect(payload).not.toHaveProperty("public_data");
    expect(() => createAgentControlWidget({ id: -7, type: "group" }, state())).toThrow();
    expect(() => encodeAgentControlState(state({ error: "🙂".repeat(300) }))).toThrow();
    expect(() => encodeAgentControlState(state({ revision: -1 }))).toThrow();
    expect(JSON.parse(encodeAgentControlState({ ...state(), unrelatedCredential: "never-public" } as AgentControlState))).not.toHaveProperty("unrelatedCredential");
  });

  test("authorization binds action to owner chat and exact widget message", () => {
    const binding = { chatId: 7, messageId: 9, telegramUserId: 7 };
    expect(authorizeWidgetQuery(query(), binding)).toBe("stop");
    for (const invalid of [query({ from: { id: 8, is_bot: false, first_name: "Other" } }), query({ message_id: 10 }), query({ chat: { id: 7, type: "group" } }), query({ data: "unknown" }), query({ data: "🙂".repeat(17) }), query({ inline_message_id: "inline" }), query({ widget_id: "shared" })]) {
      expect(() => authorizeWidgetQuery(invalid, binding)).toThrow();
    }
  });

  test("native widget adapter uses official state and query answer fields", async () => {
    const { api, calls } = mockApi([envelope({ message_id: 9, chat: { id: 7, type: "private" } }), envelope(true), envelope(true)]);
    await api.sendWidget(createAgentControlWidget({ id: 7, type: "private" }, state()));
    const data = encodeAgentControlState(state({ revision: 2 }));
    await api.editMessageWidgetData({ chat_id: 7, message_id: 9, chat_data: data });
    await api.answerWidgetQuery({ widget_query_id: "query", data });
    expect(calls[1]!.body).toEqual({ chat_id: 7, message_id: 9, chat_data: data });
    expect(calls[2]!.body).toEqual({ widget_query_id: "query", data });
  });

  test("loading disabled controls and revision reconciliation follow the official request contract", async () => {
    const h = widgetHarness(state({ status: "streaming", revision: 4, startedAt: Date.now() - 2000 }));
    expect(h.elements.stop!.disabled).toBe(false);
    expect(h.elements.new!.disabled).toBe(true);
    h.elements.stop!.onclick!();
    expect(h.actions).toEqual(["stop"]);
    expect(h.elements.stop!.disabled).toBe(true);
    expect(h.elements.pending!.textContent).toBe("Updating…");
    h.answer(state({ status: "stopped", revision: 6 }));
    await Promise.resolve();
    expect(h.elements.status!.textContent).toBe("Stopped");
    h.widget.chatData = encodeAgentControlState(state({ status: "streaming", revision: 5 }));
    h.events.chatDataChanged!();
    expect(h.elements.status!.textContent).toBe("Stopped");
    h.elements.refresh!.onclick!();
    h.fail("RATE_LIMITED");
    await Promise.resolve();
    expect(h.elements.error!.textContent).toContain("RATE_LIMITED");
  });
});
