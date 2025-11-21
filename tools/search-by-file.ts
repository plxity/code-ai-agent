import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { globToRegExp, toRelativePath, walkWorkspaceFiles } from "./utils";

export const searchByFileTool = tool({
  description:
    "Finds files whose relative paths match a glob-style pattern (supports * and ?).",
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob-style pattern. Example: `app/**/*.ts` or `*.md`."),
    searchRoot: z
      .string()
      .optional()
      .describe("Optional directory to scope the search to."),
    includeHidden: z
      .boolean()
      .default(false)
      .describe("Whether to include dotfiles and dot-directories."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of matching files to return."),
  }),
  execute: async ({
    pattern,
    searchRoot = ".",
    includeHidden = false,
    maxResults = 50,
  }) => {
    const regex = globToRegExp(pattern);
    const files = await walkWorkspaceFiles({
      startPath: searchRoot,
      includeHidden,
      maxFiles: 5_000,
    });

    const matches = files
      .map((filePath) => ({
        filePath,
        relative: toRelativePath(filePath).replace(/\\/g, "/"),
      }))
      .filter(({ relative }) => regex.test(relative))
      .slice(0, maxResults)
      .map(({ relative, filePath }) => ({
        relative,
        absolute: filePath,
      }));

    return {
      pattern,
      matches,
      totalFilesExamined: files.length,
      hasMore: matches.length >= maxResults,
    };
  },
});

