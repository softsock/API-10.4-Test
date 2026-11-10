import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  EditMessageWidgetDataParameters, GuestArticleResult, SendMessageDraftParameters,
  SendMessageParameters, SendRichMessageDraftParameters, SendRichMessageParameters,
  SendWidgetParameters, SentGuestMessage, TelegramMessage,
} from "./types";

// transport injection keeps rate-limit and ambiguous-delivery behavior testable without real bot credentials
export interface TelegramApiOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxRateLimitRetries?: number;
  timeoutMs?: number;
}

// structured errors let callers fall back only on definite telegram rejection rather than ambiguous network failures
export class TelegramApiError extends Error {
  // error metadata enables safe handling without including request urls or credentials
  constructor(public readonly method: string, public readonly errorCode: number, public readonly description: string, public readonly retryAfter?: number) {
    super(`Telegram ${method}: ${description}`);
    this.name = "TelegramApiError";
  }
}

// api envelopes are validated before any success or retry decision is made
interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

// byte limits apply to unicode state and request data rather than javascript string lengths
export function assertByteLimit(value: string, limit: number, label: string, minimum = 0): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimum || bytes > limit) throw new RangeError(`${label} must contain ${minimum}-${limit} UTF-8 bytes`);
}

// widget uploads must satisfy both telegram's source and maximum-zlib-compression limits
export function validateWidgetHtml(html: string): void {
  assertByteLimit(html, 32768, "Widget HTML", 1);
  if (deflateSync(html, { level: 9 }).byteLength > 4096) throw new RangeError("Widget compressed HTML exceeds 4096 bytes");
}

// text-only rich payloads must satisfy the official exclusive-content schema even at runtime boundaries
export function validateRichMessage(message: { markdown?: string; html?: string }): void {
  const fields = [message.markdown, message.html].filter((value) => value !== undefined);
  if (fields.length !== 1 || typeof fields[0] !== "string" || !fields[0].trim() || fields[0].length > 32768) {
    throw new RangeError("Rich messages require exactly one nonempty markdown or html field within 32768 UTF-16 units");
  }
}

// the compatibility adapter exposes only verified bot api methods and never retries ambiguous sends
export class TelegramApi {
  private readonly transport: typeof globalThis.fetch;
  private readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly retries: number;
  private readonly timeout: number;
  private readonly endpoint: string;

  // runtime credentials are kept private and never embedded in diagnostic error messages
  constructor(token: string, options: TelegramApiOptions = {}) {
    if (!token || /[\s/]/.test(token)) throw new Error("A valid Telegram bot token is required");
    this.endpoint = `https://api.telegram.org/bot${token}/`;
    this.transport = options.fetch ?? globalThis.fetch;
    this.pause = options.sleep ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
    this.retries = options.maxRateLimitRetries ?? 3;
    this.timeout = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(this.retries) || this.retries < 0 || this.timeout <= 0) throw new RangeError("Invalid Telegram retry or timeout configuration");
  }

  // only an explicit telegram flood-control rejection proves a send can safely be repeated
  private async request<T>(method: string, parameters: object, deadlineMs?: number, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + (deadlineMs ?? 30000);
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Error(`Telegram ${method}: request cancelled`);
      if (deadline !== undefined && Date.now() >= deadline) throw new Error(`Telegram ${method}: answer deadline expired`);
      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(this.timeout, deadline === undefined ? this.timeout : deadline - Date.now())));
        response = await this.transport(this.endpoint + method, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(parameters), signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
        });
      } catch {
        throw new Error(`Telegram ${method}: transport failure; delivery unknown, not retried`);
      }
      let envelope: TelegramEnvelope<T>;
      try { envelope = await response.json() as TelegramEnvelope<T>; }
      catch { throw new Error(`Telegram ${method}: invalid response; delivery unknown, not retried`); }
      if (envelope === null || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
        throw new Error(`Telegram ${method}: invalid envelope; delivery unknown, not retried`);
      }
      if (envelope.ok && response.ok && envelope.result !== undefined) return envelope.result;
      const code = envelope.error_code ?? response.status;
      const delay = envelope.parameters?.retry_after;
      if (!envelope.ok && code === 429 && Number.isFinite(delay) && delay! >= 0 && attempt < this.retries) {
        const wait = Math.max(delay! * 1000, 250 * 2 ** attempt);
        if (deadline === undefined || Date.now() + wait + 100 < deadline) {
          await this.pause(wait, signal);
          continue;
        }
      }
      throw new TelegramApiError(method, code, envelope.description ?? "API request failed", delay);
    }
  }

  // plain sends are persisted once and remain safe for untrusted or oversized model output
  sendMessage(parameters: SendMessageParameters): Promise<TelegramMessage> {
    if (parameters.text.length < 1 || parameters.text.length > 4096) throw new RangeError("Message text must contain 1-4096 UTF-16 units");
    return this.request("sendMessage", parameters, parameters.ephemeral_message_parameters ? 12000 : undefined);
  }

  // completed rich output uses the dedicated endpoint introduced for structured telegram messages
  sendRichMessage(parameters: SendRichMessageParameters): Promise<TelegramMessage> {
    validateRichMessage(parameters.rich_message);
    return this.request("sendRichMessage", parameters);
  }

  // draft validation avoids accidental zero identifiers and incomplete markdown parsing
  sendMessageDraft(parameters: SendMessageDraftParameters, signal?: AbortSignal): Promise<true> {
    if (!Number.isSafeInteger(parameters.draft_id) || parameters.draft_id === 0) throw new RangeError("draft_id must be a nonzero safe integer");
    if ((parameters.text?.length ?? 0) > 4096) throw new RangeError("Draft text exceeds 4096 UTF-16 units");
    return this.request("sendMessageDraft", parameters, undefined, signal);
  }

  // rich draft support is explicit so callers cannot confuse it with final durable delivery
  sendRichMessageDraft(parameters: SendRichMessageDraftParameters, signal?: AbortSignal): Promise<true> {
    if (!Number.isSafeInteger(parameters.draft_id) || parameters.draft_id === 0) throw new RangeError("draft_id must be a nonzero safe integer");
    validateRichMessage(parameters.rich_message);
    return this.request("sendRichMessageDraft", parameters, undefined, signal);
  }

  // widget validation happens locally before a potentially billable or permanent send
  sendWidget(parameters: SendWidgetParameters): Promise<TelegramMessage> {
    validateWidgetHtml(parameters.html);
    assertByteLimit(parameters.chat_data ?? "", 1024, "Widget chat data");
    return this.request("sendWidget", parameters);
  }

  // message-specific state edits do not publish personal controls to a shared widget
  editMessageWidgetData(parameters: EditMessageWidgetDataParameters): Promise<true> {
    assertByteLimit(parameters.chat_data, 1024, "Widget chat data");
    return this.request("editMessageWidgetData", parameters);
  }

  // widget responses must remain under their protocol's byte limit and fifteen-second answer deadline
  answerWidgetQuery(parameters: { widget_query_id: string; data?: string }): Promise<true> {
    assertByteLimit(parameters.data ?? "", 1024, "Widget answer");
    return this.request("answerWidgetQuery", parameters, 12000);
  }

  // guest invocations are answered with exactly one supported inline result rather than private-only surfaces
  answerGuestQuery(parameters: { guest_query_id: string; result: GuestArticleResult }): Promise<SentGuestMessage> {
    if (parameters.result.input_message_content.message_text.length > 4096) throw new RangeError("Guest response exceeds 4096 UTF-16 units");
    return this.request("answerGuestQuery", parameters);
  }

  // ephemeral message delivery never replaces the mandatory callback acknowledgement
  answerCallbackQuery(parameters: { callback_query_id: string; text?: string; show_alert?: boolean }): Promise<true> {
    return this.request("answerCallbackQuery", parameters, 12000);
  }

  // callback-scoped replies are visible only to the clicking user and never fall back into the surrounding chat
  async sendEphemeralReply(callbackQueryId: string, text: string): Promise<TelegramMessage> {
    const acknowledgement = this.answerCallbackQuery({ callback_query_id: callbackQueryId }).catch(() => {});
    try {
      return await this.sendMessage({ text, ephemeral_message_parameters: { callback_query_id: callbackQueryId } });
    } finally {
      await acknowledgement;
    }
  }
}
