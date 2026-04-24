import type { UIMessage } from "ai";
import { MessageType, type OutgoingMessage } from "./types";

export type MessagePartClientFilterContext = { message: UIMessage };

export type StreamChunkClientFilterContext = {
  requestId: string;
  streamId?: string;
  message?: UIMessage;
  continuation: boolean;
};

export type MessagePartClientFilter = (
  part: UIMessage["parts"][number],
  context: MessagePartClientFilterContext
) => boolean;

export function filterMessageForClient(
  message: UIMessage,
  filterPart: MessagePartClientFilter
): UIMessage {
  const parts = message.parts.filter((part) => filterPart(part, { message }));
  return parts.length === message.parts.length
    ? message
    : { ...message, parts };
}

export function filterMessagesForClient(
  messages: readonly UIMessage[],
  filterPart: MessagePartClientFilter
): readonly UIMessage[] {
  return messages.map((message) => filterMessageForClient(message, filterPart));
}

export function filterOutgoingMessageForClient(
  message: OutgoingMessage,
  filterPart: MessagePartClientFilter
): OutgoingMessage {
  if (message.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
    return {
      ...message,
      messages: filterMessagesForClient(message.messages, filterPart)
    };
  }

  if (message.type === MessageType.CF_AGENT_MESSAGE_UPDATED) {
    return {
      ...message,
      message: filterMessageForClient(message.message, filterPart)
    };
  }

  return message;
}
