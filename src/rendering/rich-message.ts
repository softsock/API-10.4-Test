import { TelegramApi, TelegramApiError } from "../telegram/api";
import type { InputRichMessage, MessageTarget, TelegramMessage } from "../telegram/types";

// rendering separates safe rich messages from lossless plain fallback chunks before any network send
export type RenderedMessage = { kind: "rich"; rich_message: InputRichMessage } | { kind: "plain"; text: string };

// chunking preserves every unicode code point and never sends partially parsed markdown
export function splitPlainText(text: string, limit = 4096): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 4096) throw new RangeError("Plain text chunk limit must be 2-4096");
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = limit;
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    const newline = remaining.lastIndexOf("\n", end - 1);
    if (newline >= end / 2) end = newline + 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// incomplete code fences must fall back rather than altering the intended model-generated source
function hasBalancedFences(text: string): boolean {
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*$/.test(line.slice(match[0].length))) fence = undefined;
  }
  return !fence;
}

// rich output accepts ordinary markdown but avoids media fetches, browser html, and protocol action links
export function renderRichMessage(input: string): RenderedMessage[] {
  const text = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (!text.trim()) return [];
  const unsafe = /!\[|<\/?[a-z][^>]*>|\]\(\s*(?!(?:https?:|mailto:|tel:|#))[^\s)]/i.test(text);
  const oversized = text.length > 16000 || text.split("\n").length > 400 || /^ {16,}\S/m.test(text);
  if (unsafe || oversized || !hasBalancedFences(text)) return splitPlainText(text).map((chunk) => ({ kind: "plain", text: chunk }));
  return [{ kind: "rich", rich_message: { markdown: text, skip_entity_detection: true } }];
}

// rejected markdown can fall back only before telegram has accepted that exact response
export async function sendRenderedResponse(api: TelegramApi, target: MessageTarget, text: string): Promise<TelegramMessage[]> {
  const messages: TelegramMessage[] = [];
  for (const part of renderRichMessage(text)) {
    if (part.kind === "plain") {
      messages.push(await api.sendMessage({ ...target, text: part.text }));
      continue;
    }
    try {
      messages.push(await api.sendRichMessage({ ...target, rich_message: part.rich_message }));
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.errorCode !== 400 || !/pars|entit|rich|format|block|unsupported/i.test(error.description)) throw error;
      for (const chunk of splitPlainText(part.rich_message.markdown ?? text)) messages.push(await api.sendMessage({ ...target, text: chunk }));
    }
  }
  return messages;
}
