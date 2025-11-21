"use client";

import {
  useMemo,
  useState,
  useCallback,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport, type UIMessage } from "ai";

type SegmentedMessage = {
  reasoning: string[];
};

type ParticipantMessage = UIMessage & { role: "user" | "assistant" };

const isParticipantMessage = (
  message: UIMessage
): message is ParticipantMessage =>
  message.role === "user" || message.role === "assistant";

function segmentMessageContent(message: ParticipantMessage): SegmentedMessage {
  const reasoningParts: string[] = [];

  for (const part of message.parts) {
    if (part.type === "reasoning" && typeof part.text === "string") {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        reasoningParts.push(trimmed);
      }
    }
  }

  return {
    reasoning: reasoningParts,
  };
}

export default function Home() {
  const transport = useMemo(
    () => new TextStreamChatTransport({ api: "/api" }),
    []
  );

  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    id: "research-copilot",
    transport,
  });

  const [inputValue, setInputValue] = useState("");

  const isLoading = status === "submitted" || status === "streaming";

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(event.target.value);
      if (error) {
        clearError();
      }
    },
    [clearError, error]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const prompt = inputValue.trim();
      if (!prompt.length || isLoading) {
        return;
      }

      setInputValue("");
      await sendMessage({ text: prompt });
    },
    [inputValue, isLoading, sendMessage]
  );

  const participantMessages = useMemo(
    () => messages.filter(isParticipantMessage),
    [messages]
  );

  const reasoningEntries = useMemo(() => {
    let assistantIndex = 0;
    const entries: { id: string; label: string; reasoning: string[] }[] = [];

    for (const message of participantMessages) {
      if (message.role !== "assistant") continue;
      const segmented = segmentMessageContent(message);
      if (!segmented.reasoning.length) continue;

      assistantIndex += 1;
      entries.push({
        id: message.id,
        label: `Response ${assistantIndex}`,
        reasoning: segmented.reasoning,
      });
    }

    return entries;
  }, [participantMessages]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-10 lg:flex-row">
        <section className="flex-1 space-y-4">
          <form
            onSubmit={handleSubmit}
            className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4"
          >
            <label className="text-sm font-medium text-zinc-300">
              Ask anything
            </label>
            <textarea
              value={inputValue}
              onChange={handleInputChange}
              placeholder="Ask the model anything…"
              rows={4}
              className="w-full resize-none rounded-xl border border-zinc-700 bg-black/40 px-4 py-3 text-base text-zinc-50 outline-none transition focus:border-sky-500"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => stop()}
                disabled={!isLoading}
                className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition enabled:hover:border-red-400 enabled:hover:text-red-200 disabled:opacity-40"
              >
                Stop
              </button>
              <button
                type="submit"
                disabled={!inputValue.trim().length || isLoading}
                className="rounded-full bg-sky-500 px-6 py-2 text-sm font-semibold text-black transition enabled:hover:bg-sky-400 disabled:opacity-50"
              >
                {isLoading ? "Streaming…" : "Send"}
              </button>
            </div>
          </form>

          {error && (
            <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
              {error.message || "Something went wrong. Please try again."}
            </p>
          )}
        </section>

        <aside className="w-full rounded-2xl border border-amber-300/30 bg-amber-500/5 p-5 lg:w-80">
          <div className="space-y-4">
            <header>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-300/80">
                Reasoning
              </p>
              <h2 className="text-xl font-semibold text-amber-50">
                Model thoughts, separate from the final answer.
              </h2>
              <p className="mt-1 text-sm text-amber-100/80">
                Streaming reasoning traces emitted by <code>gpt-5.1</code>{" "}
                appear here as soon as they become available.
              </p>
            </header>

            {reasoningEntries.length === 0 ? (
              <p className="rounded-xl border border-amber-200/30 bg-amber-100/5 p-3 text-sm text-amber-100/70">
                The model will share its thought process once you start a chat.
              </p>
            ) : (
              <ol className="space-y-4">
                {reasoningEntries.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-amber-200/40 bg-amber-50/5 p-3"
                  >
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-200/90">
                      {entry.label}
                    </p>
                    <div className="space-y-2 text-sm text-amber-50/90">
                      {entry.reasoning.map((chunk, index) => (
                        <p key={index} className="whitespace-pre-wrap">
                          {chunk}
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}