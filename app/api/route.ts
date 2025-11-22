import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type CoreMessage } from "ai";
import { SYSTEM_PROMPT } from "@/app/api/prompt";
import { NextRequest } from "next/server";

import { agentTools } from "@/tools";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

class InvalidMessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageFormatError";
  }
}

type AgentRequestPayload = {
  messages?: unknown;
  question?: string;
  temperature?: number;
  maxTokens?: number;
};

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response("Missing OPENAI_API_KEY environment variable.", {
      status: 500,
    });
  }

  let payload: AgentRequestPayload = {};

  try {
    payload = await req.json();
  } catch {
    // no-op: fall back to empty payload and validate below
  }

  const {
    messages = [],
    question,
  } = payload;

  let conversation: CoreMessage[];
  try {
    conversation = normalizeMessages(messages, question);
  } catch (error) {
    if (error instanceof InvalidMessageFormatError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }

  if (!conversation.length) {
    return new Response("Provide a `question` string or `messages` array.", {
      status: 400,
    });
  }

  const result = await streamText({
    model: openai("gpt-5.1"),
    system: SYSTEM_PROMPT,
    messages: conversation,
    maxRetries: 100,
    tools: agentTools,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        parallelToolCalls: true,
      },
    },
    stopWhen: shouldStopAfterToolUse,
    onStepFinish: async (step) => {
      // Log each step as soon as it completes (tool call, model response, etc.)
      try {
        const toolNames =
          step.toolCalls?.map((call) => call.toolName).join(", ") ?? null;
        const finishReason = step.finishReason ?? "unknown";

        console.log(
          "[streamText:onStepFinish]",
          `step`,
          `finishReason=${finishReason}`,
          toolNames ? `tools=${toolNames}` : "tools=none",
        );
      } catch (error) {
        console.error("Failed to log streamText step:", error);
      }
    },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              if (typeof part.text === "string") {
                controller.enqueue(encoder.encode(part.text));
              }
              break;
            case "reasoning-delta":
              if (typeof part.text === "string") {
                controller.enqueue(
                  encoder.encode(`[reasoning] ${part.text}\n`),
                );
              }
              break;
            case "tool-call":
              controller.enqueue(
                encoder.encode(
                  `\n[tool-call:start] ${part.toolName}${
                    part.callId ? ` (id=${part.callId})` : ""
                  }\n`,
                ),
              );
              if (part.args !== undefined) {
                controller.enqueue(
                  encoder.encode(
                    `${toJson(part.args)}\n`,
                  ),
                );
              }
              break;
            case "tool-result":
              controller.enqueue(
                encoder.encode(
                  `\n[tool-call:result] ${part.toolName ?? ""}\n${toJson(
                    part.result,
                  )}\n`,
                ),
              );
              break;
            case "tool-error":
              controller.enqueue(
                encoder.encode(
                  `\n[tool-call:error] ${
                    part.toolName ?? ""
                  }\n${toJson(part.error)}\n`,
                ),
              );
              break;
            default:
              break;
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function normalizeMessages(
  messagesInput: unknown,
  questionInput: unknown,
): CoreMessage[] {
  if (Array.isArray(messagesInput) && messagesInput.length > 0) {
    if (messagesInput.every(isCoreMessageShape)) {
      return messagesInput as CoreMessage[];
    }

    if (messagesInput.every(isUIMessageShape)) {
      const converted = convertUIMessagesToCoreMessages(
        messagesInput as UIMessageShape[],
      );
      if (converted.length > 0) {
        return converted;
      }

      return [];
    }

    throw new InvalidMessageFormatError(
      "Invalid `messages` payload. Provide an array of CoreMessage or UIMessage objects.",
    );
  }

  if (typeof questionInput === "string" && questionInput.trim().length) {
    return [
      {
        role: "user",
        content: questionInput.trim(),
      },
    ];
  }

  return [];
}

function isCoreMessageShape(candidate: unknown): candidate is CoreMessage {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("role" in candidate)
  ) {
    return false;
  }

  const role = (candidate as { role?: unknown }).role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "system" &&
    role !== "tool"
  ) {
    return false;
  }

  return "content" in (candidate as Record<string, unknown>);
}

function shouldStopAfterToolUse({
  steps,
}: {
  steps: Array<{ finishReason?: string }>;
}) {
  const lastStep = steps[steps.length - 1];
  if (!lastStep) {
    return true;
  }
  return lastStep.finishReason !== "tool-calls";
}

type UIMessageShape = {
  role?: unknown;
  parts?: unknown;
};

type SupportedRoles = Extract<
  CoreMessage["role"],
  "system" | "user" | "assistant"
>;

function isUIMessageShape(candidate: unknown): candidate is UIMessageShape {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("role" in candidate)
  ) {
    return false;
  }

  const parts = (candidate as { parts?: unknown }).parts;
  return Array.isArray(parts);
}

function convertUIMessagesToCoreMessages(
  messages: UIMessageShape[],
): CoreMessage[] {
  const normalized: CoreMessage[] = [];

  for (const message of messages) {
    const role = normalizeRole(message.role);
    if (!role) {
      continue;
    }

    const content = extractTextFromUIParts(message.parts);
    if (!content) {
      continue;
    }

    const normalizedMessage: CoreMessage = {
      role,
      content,
    };

    normalized.push(normalizedMessage);
  }

  return normalized;
}

function normalizeRole(role: unknown): SupportedRoles | null {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }

  return null;
}

function extractTextFromUIParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const textChunks = parts
    .map((part) => {
      if (
        typeof part !== "object" ||
        part === null ||
        !("type" in part) ||
        !("text" in part)
      ) {
        return "";
      }

      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if (
        (type === "text" || type === "reasoning") &&
        typeof text === "string"
      ) {
        const trimmed = text.trim();
        return trimmed.length > 0 ? trimmed : "";
      }

      return "";
    })
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  if (!textChunks.length) {
    return undefined;
  }

  return textChunks.join("\n\n");
}

function toJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


