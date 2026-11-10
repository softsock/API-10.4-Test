// text rich messages keep the official mutually exclusive content fields without exposing media or executable controls
export type InputRichMessage = ({ markdown: string; html?: never } | { html: string; markdown?: never }) & {
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

// numeric identities retain telegram's exact user and chat scope across unsupported update types
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

// chat type is required to prevent private-only surfaces from reaching groups
export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

// responses expose only fields this application consumes while telegram may return additional message fields
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  message_thread_id?: number;
  text?: string;
  guest_query_id?: string;
}

// ephemeral callback replies intentionally omit receiver identity so telegram scopes visibility to the clicking user
export interface EphemeralMessageParameters {
  callback_query_id: string;
  receiver_user_id?: never;
  replace_callback_query_message?: false;
}

// durable and ephemeral targets are mutually exclusive to prevent accidental disclosure into the surrounding chat
export type MessageTarget = {
  chat_id: number | string;
  message_thread_id?: number;
  ephemeral_message_parameters?: never;
} | {
  chat_id?: never;
  message_thread_id?: never;
  ephemeral_message_parameters: EphemeralMessageParameters;
};

// ordinary messages also provide the safe unformatted fallback for rejected rich output
export type SendMessageParameters = MessageTarget & {
  text: string;
  protect_content?: boolean;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

// final rich replies use telegram's rich schema rather than browser html or legacy markdown parse modes
export type SendRichMessageParameters = MessageTarget & { rich_message: InputRichMessage; protect_content?: boolean };

// draft coordinates bind cancellation to the exact private conversation and nonzero generation identifier
export interface DraftTarget {
  chat_id: number;
  message_thread_id?: number;
  draft_id: number;
  can_stop?: boolean;
  keep_on_stop?: boolean;
}

// plain drafts avoid parsing incomplete model markdown during token streaming
export interface SendMessageDraftParameters extends DraftTarget {
  text?: string;
}

// rich drafts are available only when callers already have a complete valid rich fragment
export interface SendRichMessageDraftParameters extends DraftTarget {
  rich_message: InputRichMessage;
}

// native stop updates do not include a user object and must be resolved through persisted draft ownership
export interface MessageGenerationStopped {
  chat: TelegramChat;
  message_thread_id?: number;
  draft_id: number;
}

// widget requests carry their action at top level rather than inside the query type
export interface WidgetQuery {
  id: string;
  from: TelegramUser;
  chat?: TelegramChat;
  message_id?: number;
  inline_message_id?: string;
  chat_instance: string;
  chat_type?: string;
  type: { type: "data" } | { type: "sign_data" | "sent_transaction" };
  data: string;
  widget_id?: string;
}

// widget delivery is message specific and never opts into public shared state
export interface SendWidgetParameters {
  chat_id: number;
  message_thread_id?: number;
  html: string;
  chat_data?: string;
  allow_queries: true;
  is_shared?: false;
  height?: number;
}

// widget edits update only the owning message rather than public shared widget data
export interface EditMessageWidgetDataParameters {
  chat_id: number;
  message_id: number;
  chat_data: string;
}

// concise guest results use the official inline article variant without assuming chat history access
export interface GuestArticleResult {
  type: "article";
  id: string;
  title: string;
  input_message_content: { message_text: string };
}

// guest answers return an inline identifier rather than a regular chat message
export interface SentGuestMessage {
  inline_message_id: string;
}

// unsupported update fields remain typed independently of the installed grammy schema version
export interface TelegramSurfaceUpdate {
  update_id: number;
  guest_message?: TelegramMessage;
  widget_query?: WidgetQuery;
  stopped_message_generation?: MessageGenerationStopped;
}
