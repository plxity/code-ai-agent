import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type CoreMessage, type GenerateTextResult } from "ai";
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

  const result = await generateText({
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
  });

  const responsePayload = {
    summary: {
      answer: extractAnswerText(result),
      finishReason: result.finishReason ?? null,
    },
  };

  return new Response(JSON.stringify(responsePayload, null, 2), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function normalizeMessages(
  messagesInput: unknown,
  questionInput: unknown,
): CoreMessage[] {
  if (Array.isArray(messagesInput) && messagesInput.length > 0) {
    if (!messagesInput.every(isCoreMessageShape)) {
      throw new InvalidMessageFormatError(
        "Invalid `messages` payload. Provide an array of CoreMessage objects.",
      );
    }

    return messagesInput as CoreMessage[];
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

function extractAnswerText(result: GenerateTextResult) {
  const directText = typeof result.text === "string" ? result.text.trim() : "";
  if (directText.length > 0) {
    return directText;
  }

  const responseMessages = (
    (result.response as {
      messages?: Array<{
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    }) ?? {}
  ).messages;

  if (!Array.isArray(responseMessages)) {
    return "";
  }

  const assistantTexts = responseMessages
    .filter((message) => message?.role === "assistant")
    .map((message) => {
      if (!Array.isArray(message?.content)) {
        return "";
      }

      return message.content
        .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
        .filter((chunk) => chunk.length > 0)
        .join("\n\n");
    })
    .filter((chunk) => chunk.length > 0);

  return assistantTexts.join("\n\n").trim();
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


