import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";

import {
  TEXT_FILE_EXTENSIONS,
  readTextFile,
  toRelativePath,
  tokenize,
  walkWorkspaceFiles,
} from "./utils";

const DEFAULT_MAX_SNIPPET = 600;

export const searchSemanticTool = tool({
  description:
    "Performs a lightweight semantic search by scoring files against the query tokens.",
  inputSchema: z.object({
    query: z.string().min(2).describe("Question or concept to search for."),
    searchRoot: z
      .string()
      .optional()
      .describe("Directory to scope the search to."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("How many matches to return."),
    maxSnippetLength: z
      .number()
      .int()
      .min(120)
      .max(1_200)
      .default(DEFAULT_MAX_SNIPPET)
      .describe("Maximum characters to include per snippet."),
  }),
  execute: async ({
    query,
    searchRoot = ".",
    maxResults = 5,
    maxSnippetLength = DEFAULT_MAX_SNIPPET,
  }) => {
    const tokens = Array.from(new Set(tokenize(query)));
    if (tokens.length === 0) {
      throw new Error("Provide a more descriptive query.");
    }

    const files = await walkWorkspaceFiles({
      startPath: searchRoot,
      extensions: TEXT_FILE_EXTENSIONS,
      maxFiles: 2_500,
    });

    const queryLower = query.toLowerCase();
    const findings: Array<{
      file: string;
      score: number;
      snippet: string;
      line?: number;
      truncated: boolean;
    }> = [];

    for (const filePath of files) {
      const { content, truncated } = await readTextFile(
        filePath,
        50_000,
        "utf8",
      );
      const lowerContent = content.toLowerCase();

      let fileScore = 0;
      let bestIndex = -1;
      let bestTerm = "";

      if (lowerContent.includes(queryLower)) {
        bestIndex = lowerContent.indexOf(queryLower);
        bestTerm = queryLower;
        fileScore += queryLower.length * 3;
      }

      for (const token of tokens) {
        const occurrences = occurrencesOf(lowerContent, token);
        if (occurrences > 0) {
          if (bestIndex === -1) {
            bestIndex = lowerContent.indexOf(token);
            bestTerm = token;
          }

          fileScore += occurrences * (token.length + 1);
        }
      }

      if (fileScore === 0) continue;

      const snippetInfo = buildSnippet(
        content,
        lowerContent,
        bestIndex,
        bestTerm,
        maxSnippetLength,
        tokens,
      );

      findings.push({
        file: toRelativePath(filePath),
        score: Number(fileScore.toFixed(2)),
        snippet: snippetInfo.text,
        line: snippetInfo.lineNumber,
        truncated: truncated || snippetInfo.truncated,
      });
    }

    findings.sort((a, b) => b.score - a.score);

    return {
      query,
      results: findings.slice(0, maxResults),
      searchedFiles: files.length,
      hasMore: findings.length > maxResults,
    };
  },
});

function occurrencesOf(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function buildSnippet(
  originalContent: string,
  lowerContent: string,
  index: number,
  term: string,
  maxLength: number,
  tokens: string[],
) {
  let targetIndex = index;
  let targetTerm = term;

  if (targetIndex === -1) {
    targetTerm = "";
    for (const fallback of tokens) {
      const candidateIndex = lowerContent.indexOf(fallback);
      if (candidateIndex !== -1) {
        targetIndex = candidateIndex;
        targetTerm = fallback;
        break;
      }
    }
  }

  if (targetIndex === -1) {
    const preview = originalContent.slice(0, maxLength);
    return {
      text: preview,
      lineNumber: 1,
      truncated: preview.length < originalContent.length,
    };
  }

  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, targetIndex - half);
  const end = Math.min(originalContent.length, start + maxLength);

  const snippet = originalContent.slice(start, end);
  const prefixLines = originalContent
    .slice(0, targetIndex)
    .split(/\r?\n/)
    .length;

  return {
    text: snippet,
    lineNumber: prefixLines,
    truncated: end < originalContent.length,
    term: targetTerm,
  };
}

