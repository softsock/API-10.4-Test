import { timingSafeEqual } from "node:crypto";

// isolate the HTTP trust boundary from Telegram dispatch and model latency
export interface ServerDependencies {
  secret: string;
  ready: () => boolean;
  accept: (update: { update_id: number; [key: string]: unknown }) => boolean;
}

// compare webhook credentials without exposing the matching prefix through timing
export function authentic(header: string | null, expected: string): boolean {
  if (!header) return false;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// durably acknowledge authenticated updates before any expensive agent work begins
export function createHandler(deps: ServerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return Response.json({ status: "alive" });
    if (request.method === "GET" && path === "/ready") return Response.json({ ready: deps.ready() }, { status: deps.ready() ? 200 : 503 });
    if (request.method !== "POST" || path !== "/telegram/webhook") return new Response("Not found", { status: 404 });
    if (!authentic(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), deps.secret)) return new Response("Unauthorized", { status: 401 });
    if (!deps.ready()) return new Response("Not ready", { status: 503 });
    if (Number(request.headers.get("content-length")) > 262144) return new Response("Too large", { status: 413 });
    try {
      const reader = request.body?.getReader();
      if (!reader) return new Response("Invalid update", { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 262144) {
          await reader.cancel();
          return new Response("Too large", { status: 413 });
        }
        chunks.push(part.value);
      }
      const update: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!update || typeof update !== "object" || !("update_id" in update) || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) {
        return new Response("Invalid update", { status: 400 });
      }
      deps.accept(update as { update_id: number; [key: string]: unknown });
      return new Response("OK");
    } catch (error) {
      return new Response(error instanceof SyntaxError ? "Invalid JSON" : "Temporarily unavailable", { status: error instanceof SyntaxError ? 400 : 503 });
    }
  };
}
