import { tool } from "@ai-sdk/provider-utils";
import { promises as fs } from "node:fs";
import { z } from "zod";

import {
  TEXT_FILE_EXTENSIONS,
  toRelativePath,
  walkWorkspaceFiles,
} from "./utils";

export const searchByKeywordTool = tool({
  description:
    "Searches text files for the provided keywords and returns contextual matches.",
  inputSchema: z.object({
    keywords: z
      .array(z.string().min(1))
      .min(1)
      .describe("Keywords or phrases to look for."),
    searchRoot: z
      .string()
      .optional()
      .describe("Directory to limit the search to. Defaults to the repo root."),
    caseSensitive: z
      .boolean()
      .default(false)
      .describe("Whether the match should be case-sensitive."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Cap on the number of matches to return."),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2)
      .describe("Number of surrounding lines to include in each result."),
  }),
  execute: async ({
    keywords,
    searchRoot = ".",
    caseSensitive = false,
    maxResults = 20,
    contextLines = 2,
  }) => {
    const normalizedKeywords = caseSensitive
      ? keywords
      : keywords.map((keyword) => keyword.toLowerCase());

    const files = await walkWorkspaceFiles({
      startPath: searchRoot,
      extensions: TEXT_FILE_EXTENSIONS,
      maxFiles: 2_000,
    });

    const matches: Array<{
      file: string;
      line: number;
      keyword: string;
      snippet: string;
    }> = [];

    for (const filePath of files) {
      if (matches.length >= maxResults) break;

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        if (matches.length >= maxResults) break;

        const line = lines[lineIndex]!;
        const comparableLine = caseSensitive ? line : line.toLowerCase();

        for (let i = 0; i < normalizedKeywords.length; i++) {
          const keyword = normalizedKeywords[i]!;
          if (!keyword) continue;

          if (comparableLine.includes(keyword)) {
            const contextStart = Math.max(0, lineIndex - contextLines);
            const contextEnd = Math.min(
              lines.length,
              lineIndex + contextLines + 1,
            );
            const snippet = lines.slice(contextStart, contextEnd).join("\n");

            matches.push({
              file: toRelativePath(filePath),
              line: lineIndex + 1,
              keyword: caseSensitive ? keyword : keywords[i]!,
              snippet,
            });

            break;
          }
        }
      }
    }

    return {
      matches,
      keywords,
      caseSensitive,
      searchedFiles: files.length,
      hasMore: matches.length >= maxResults,
    };
  },
});

