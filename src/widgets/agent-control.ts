import { assertByteLimit, validateWidgetHtml } from "../telegram/api";
import type { SendWidgetParameters, TelegramChat, WidgetQuery } from "../telegram/types";

// explicit states prevent unavailable operations and invented progress from appearing in the control surface
export type AgentControlStatus = "idle" | "thinking" | "streaming" | "completed" | "stopped" | "error";

// only actual model and provider-reported usage belong in this message-specific control state
export interface AgentControlState {
  revision: number;
  agent: string;
  status: AgentControlStatus;
  model: string;
  operation: string;
  startedAt?: number;
  finishedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

// the compact action vocabulary remains comfortably inside telegram's sixty-four-byte request limit
export type WidgetAction = "stop" | "new" | "status";

// database-backed message ownership is authoritative rather than any widget-provided identity or state
export interface WidgetBinding {
  chatId: number;
  messageId: number;
  telegramUserId: number;
}

// bounded state validation prevents invalid revisions and oversized user-visible data from reaching telegram
export function encodeAgentControlState(state: AgentControlState): string {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new RangeError("Invalid widget revision");
  if (!["idle", "thinking", "streaming", "completed", "stopped", "error"].includes(state.status)) throw new Error("Invalid widget status");
  for (const value of [state.startedAt, state.finishedAt, state.inputTokens, state.outputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("Invalid widget timestamp or usage");
  }
  for (const value of [state.agent, state.model, state.operation]) {
    if (typeof value !== "string") throw new TypeError("Invalid widget text");
  }
  if (state.error !== undefined && typeof state.error !== "string") throw new TypeError("Invalid widget error summary");
  const data = JSON.stringify({ revision: state.revision, agent: state.agent, status: state.status,
    model: state.model, operation: state.operation, startedAt: state.startedAt, finishedAt: state.finishedAt,
    inputTokens: state.inputTokens, outputTokens: state.outputTokens, error: state.error });
  assertByteLimit(data, 1024, "Agent Control state");
  return data;
}

// the immutable self-contained html uses supported quickjs capabilities and native telegram palette variables
export const AGENT_CONTROL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:14px;background:var(--tg-theme-bg-color);color:var(--tg-theme-text-color)}
h3{margin:0 0 6px}p{margin:6px 0;overflow-wrap:break-word}.hint{color:var(--tg-theme-hint-color);font-size:13px}
#agent,#model,#operation,#error{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.controls{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}button{flex:1;padding:9px 7px;border:0;border-radius:8px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
button[disabled]{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color)}#error{color:var(--tg-theme-destructive-text-color);font-size:13px}#stop{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-destructive-text-color)}
</style></head><body><h3 id="agent">Agent Control</h3><p id="status">Loading status…</p><p class="hint" id="model"></p><p id="operation"></p><p class="hint" id="elapsed"></p><p class="hint" id="usage"></p><div class="controls"><button id="stop" disabled>Stop Generation</button><button id="new" disabled>New Session</button><button id="refresh" disabled>Refresh Status</button></div><p class="hint" id="pending"></p><p id="error"></p><script>
const TW=window.TelegramWidget;
let state=null,busy=false,feedback='';
// direct element access keeps untrusted state out of html parsing
function el(id){return document.getElementById(id)}
// private production controls remain disabled in previews and unsupported contexts
function available(){return !!TW&&!TW.isPreview&&!TW.isForward&&TW.chatType==='private'&&!!TW.viewer}
// only actual running generations keep the elapsed clock moving
function active(){return !!state&&(state.status==='thinking'||state.status==='streaming')}
// backend revisions prevent delayed state events from undoing a newer request answer
function reconcile(value){try{const next=JSON.parse(value);if(next&&Number.isSafeInteger(next.revision)&&typeof next.status==='string'&&(!state||next.revision>=state.revision))state=next}catch(e){}draw()}
// derived elapsed time stops when the backend supplies the completion timestamp
function clock(){if(!state||!Number.isFinite(state.startedAt)){el('elapsed').textContent='';return}const end=state.finishedAt||(active()?Date.now():state.startedAt);el('elapsed').textContent='Elapsed: '+Math.max(0,Math.floor((end-state.startedAt)/1000))+'s'}
// text-only rendering preserves private backend state without script or markup execution
function draw(){el('agent').textContent=state?state.agent+' · Agent Control':'Agent Control';el('status').textContent=state?state.status.charAt(0).toUpperCase()+state.status.slice(1):'Status unavailable';el('model').textContent=state?'Model: '+state.model:'';el('operation').textContent=state?state.operation:'';el('usage').textContent=state&&(state.inputTokens!==undefined||state.outputTokens!==undefined)?'Tokens: '+(state.inputTokens===undefined?'—':state.inputTokens)+' in / '+(state.outputTokens===undefined?'—':state.outputTokens)+' out':'';el('stop').disabled=busy||!available()||!active();el('new').disabled=busy||!available()||!state||active();el('refresh').disabled=busy||!available();el('pending').textContent=busy?'Updating…':'';el('error').textContent=feedback||(state&&state.error)||(!available()?'Open this widget in your private chat with the bot.':'');clock()}
// request results accelerate reconciliation but never pretend to persist widget state
function answered(answer){busy=false;feedback='';if(answer&&typeof answer.result==='string'){try{const result=JSON.parse(answer.result);if(result.error)feedback=String(result.error);if(result.state)reconcile(JSON.stringify(result.state));else if(result.revision!==undefined)reconcile(answer.result)}catch(e){feedback='Invalid server answer'}}draw()}
// failed requests leave existing state visible and provide recoverable feedback
function failed(error){busy=false;feedback='Request failed: '+String(error&&error.code||'FAILED');draw()}
// requests run synchronously inside real click handlers to satisfy telegram's gesture requirement
function request(action){if(busy||!available())return;busy=true;feedback='';draw();try{TW.request(action).then(answered,failed)}catch(error){failed(error)}}
// native stop maps to the owning backend generation rather than a global cancellation
function stop(){request('stop')}
// new sessions are unavailable while a generation is active
function fresh(){request('new')}
// manual refresh recovers status without network access inside the widget
function refresh(){request('status')}
// message state edits reconcile through the same revision gate as request answers
function changed(){reconcile(TW.chatData)}
el('stop').onclick=stop;el('new').onclick=fresh;el('refresh').onclick=refresh;
if(TW){TW.onEvent('chatDataChanged',changed);TW.onEvent('themeChanged',draw);TW.onEvent('activated',draw);changed();TW.ready()}else draw();
setInterval(clock,1000);
</script></body></html>`;

// widget construction rejects nonprivate chats before creating any production-only telegram surface
export function createAgentControlWidget(chat: TelegramChat, state: AgentControlState, messageThreadId?: number): SendWidgetParameters {
  if (chat.type !== "private") throw new Error("Agent Control widgets are supported only in private chats");
  validateWidgetHtml(AGENT_CONTROL_HTML);
  return {
    chat_id: chat.id, ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
    html: AGENT_CONTROL_HTML, chat_data: encodeAgentControlState(state), allow_queries: true, is_shared: false,
  };
}

// authorization compares exact database ownership and message coordinates before accepting any privileged action
export function authorizeWidgetQuery(query: WidgetQuery, binding: WidgetBinding): WidgetAction {
  assertByteLimit(query.data, 64, "Widget request", 1);
  if (query.type.type !== "data" || query.widget_id || query.inline_message_id || query.chat?.type !== "private" ||
      query.from.id !== binding.telegramUserId || query.chat.id !== binding.chatId || query.message_id !== binding.messageId) {
    throw new Error("Widget action is not authorized for this user and message");
  }
  if (query.data !== "stop" && query.data !== "new" && query.data !== "status") throw new Error("Unknown widget action");
  return query.data;
}
