import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "@ai-sdk/provider-utils";
import { streamText } from "ai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_SNIPPETS = 8;
const MAX_SNIPPET_LENGTH = 4_000;

export const summarizeSnippetsTool = tool({
  description:
    "Condenses multiple code/document snippets into an actionable summary, citing the provided file paths.",
  inputSchema: z.object({
    snippets: z
      .array(
        z.object({
          filePath: z.string().min(1).describe("Path or label for the snippet."),
          content: z
            .string()
            .min(1, "Snippet content cannot be empty.")
            .describe("Excerpt to summarize."),
        }),
      )
      .min(1)
      .max(
        MAX_SNIPPETS,
        `Provide at most ${MAX_SNIPPETS} snippets per request to keep summaries focused.`,
      ),
    instructions: z
      .string()
      .max(800)
      .optional()
      .describe(
        "Optional guidance for the summary (e.g., focus areas, open questions).",
      ),
    format: z
      .enum(["bullets", "paragraph"])
      .default("bullets")
      .describe("Preferred summary style."),
  }),
  execute: async ({ snippets, instructions, format }) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required to summarize snippets.");
    }

    const constrainedSnippets = snippets.map(({ filePath, content }) => ({
      filePath,
      content:
        content.length > MAX_SNIPPET_LENGTH
          ? `${content.slice(0, MAX_SNIPPET_LENGTH)}\n[...truncated...]`
          : content,
    }));

    const promptSections = constrainedSnippets
      .map(
        ({ filePath, content }, index) =>
          `Snippet ${index + 1} — ${filePath}\n${content}`,
      )
      .join("\n\n");

    const summaryStyle =
      format === "bullets"
        ? "Return 3-6 bullet points, each referencing relevant files."
        : "Return a concise paragraph (~120 words) referencing relevant files.";

    const extraInstructions = instructions
      ? `Extra instructions from the user:\n${instructions}\n\n`
      : "";

    const prompt = `${extraInstructions}Summarize the following code/document excerpts.\n${summaryStyle}\nIf there are open questions or missing context, explicitly list them.\n\n${promptSections}`;

    const result = await streamText({
      model: openai("gpt-5.1-mini"),
      system:
        "You are an engineering copilot summarizing repository context. Cite file paths explicitly and keep speculation to a minimum.",
      prompt,
      maxRetries: 2,
    });

    const summaryText = (await result.text)?.trim();

    if (!summaryText) {
      throw new Error("Summary generation returned empty text.");
    }

    return {
      summary: summaryText,
      snippetCount: constrainedSnippets.length,
      format,
    };
  },
});


