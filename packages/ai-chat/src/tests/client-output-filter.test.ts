import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    messages.push(JSON.parse(event.data as string));
  });
  return messages;
}

function sendChatRequest(ws: WebSocket, requestId: string): void {
  const message: ChatMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Hello" }]
  };

  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [message] })
      }
    })
  );
}

function isChatMessagesMessage(
  message: unknown
): message is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_CHAT_MESSAGES }
> {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === MessageType.CF_AGENT_CHAT_MESSAGES
  );
}

async function waitForDone(
  ws: WebSocket,
  requestId: string,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    function handler(event: MessageEvent) {
      const data = JSON.parse(event.data as string);
      if (
        isUseChatResponseMessage(data) &&
        data.done &&
        data.id === requestId
      ) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(true);
      }
    }
    ws.addEventListener("message", handler);
  });
}

function collectStreamChunkTypes(messages: unknown[]): string[] {
  return messages
    .filter(isUseChatResponseMessage)
    .filter((message) => !message.done)
    .map((message) => JSON.parse(message.body) as { type: string })
    .map((chunk) => chunk.type);
}

function assistantParts(
  messages: readonly ChatMessage[]
): ChatMessage["parts"] {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts);
}

function isHiddenInternalPart(part: ChatMessage["parts"][number]): boolean {
  if (part.type !== "data-internal") return false;

  const data = part.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "note" in data &&
    data.note === "hidden from clients"
  );
}

describe("client output filtering", () => {
  it("filters selected stream chunks and message parts from clients while keeping them persisted", async () => {
    const room = crypto.randomUUID();
    const requestId = "filtered-client-output-request";
    const { ws } = await connectChatWS(
      `/agents/client-output-filter-agent/${room}`
    );
    const { ws: observer } = await connectChatWS(
      `/agents/client-output-filter-agent/${room}`
    );
    const senderMessages = collectMessages(ws);
    const observerMessages = collectMessages(observer);
    const done = waitForDone(ws, requestId);

    sendChatRequest(ws, requestId);

    expect(await done).toBe(true);
    const agentStub = await getAgentByName(env.ClientOutputFilterAgent, room);
    await agentStub.waitForIdleForTest();

    const streamedChunkTypes = collectStreamChunkTypes(senderMessages);
    expect(streamedChunkTypes).toContain("text-start");
    expect(streamedChunkTypes).toContain("text-delta");
    expect(streamedChunkTypes).toContain("text-end");
    expect(streamedChunkTypes).not.toContain("reasoning-start");
    expect(streamedChunkTypes).not.toContain("reasoning-delta");
    expect(streamedChunkTypes).not.toContain("reasoning-end");
    expect(streamedChunkTypes).not.toContain("data-internal");

    const finalObserverMessage = observerMessages
      .filter(isChatMessagesMessage)
      .at(-1);
    expect(finalObserverMessage).toBeDefined();
    expect(
      assistantParts(finalObserverMessage?.messages ?? []).some(
        (part) => part.type === "reasoning" || part.type === "data-internal"
      )
    ).toBe(false);

    const response = await exports.default.fetch(
      `http://example.com/agents/client-output-filter-agent/${room}/get-messages`
    );
    const clientMessages = (await response.json()) as ChatMessage[];
    expect(
      assistantParts(clientMessages).some(
        (part) => part.type === "reasoning" || part.type === "data-internal"
      )
    ).toBe(false);

    const persistedMessages = await agentStub.getPersistedMessages();
    const persistedParts = assistantParts(persistedMessages);
    expect(
      persistedParts.some(
        (part) => part.type === "reasoning" && part.text === "private reasoning"
      )
    ).toBe(true);
    expect(persistedParts.some(isHiddenInternalPart)).toBe(true);
    expect(
      persistedParts.some(
        (part) => part.type === "text" && part.text === "Visible answer."
      )
    ).toBe(true);

    ws.close(1000);
    observer.close(1000);
  });
});
