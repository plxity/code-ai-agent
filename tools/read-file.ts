import { tool } from "@ai-sdk/provider-utils";
import { promises as fs } from "node:fs";
import { z } from "zod";

import { resolveWorkspacePath, safeStat } from "./utils";

const ALLOWED_ENCODINGS: BufferEncoding[] = [
  "utf8",
  "utf-8",
  "utf16le",
  "latin1",
  "ascii",
];

export const readFileTool = tool({
  description:
    "Reads a file from the repository and returns its contents with optional slicing.",
  inputSchema: z.object({
    filePath: z
      .string()
      .min(1)
      .describe("Relative path to the file that should be read."),
    encoding: z
      .string()
      .optional()
      .describe(
        "Text encoding to use (utf8, utf-8, utf16le, latin1, ascii). Defaults to utf8.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Starting byte offset before returning the text."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500_000)
      .optional()
      .describe("Maximum number of bytes to return."),
  }),
  execute: async ({ filePath, encoding, offset = 0, limit }) => {
    const { absolute, relative } = resolveWorkspacePath(filePath);
    const stats = await safeStat(absolute);

    if (!stats) {
      throw new Error(`File not found: ${relative}`);
    }

    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${relative}`);
    }

    const normalizedEncoding =
      (encoding &&
        ALLOWED_ENCODINGS.find(
          (candidate) => candidate.toLowerCase() === encoding.toLowerCase(),
        )) ||
      "utf8";

    const rawContent = await fs.readFile(absolute, normalizedEncoding);
    const start = Math.min(offset, rawContent.length);
    const end = limit ? Math.min(start + limit, rawContent.length) : rawContent.length;
    const snippet = rawContent.slice(start, end);

    return {
      path: relative,
      encoding: normalizedEncoding,
      totalBytes: rawContent.length,
      snippet,
      offset: start,
      end,
      truncated: end < rawContent.length,
      lastModified: stats.mtime.toISOString(),
    };
  },
});

