import { tool } from "@ai-sdk/provider-utils";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  IGNORED_DIRECTORIES,
  isHiddenName,
  resolveWorkspacePath,
} from "./utils";

type TreeOptions = {
  maxDepth: number;
  includeHidden: boolean;
  includeFiles: boolean;
};

export const generateFileStructureTool = tool({
  description:
    "Returns a tree-style snapshot of the repository starting at `startPath`.",
  inputSchema: z.object({
    startPath: z
      .string()
      .describe(
        "Path to begin the tree from. Can be relative to the repository root.",
      )
      .optional(),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Maximum depth to traverse from the starting path."),
    includeHidden: z
      .boolean()
      .default(false)
      .describe("Whether to include dotfiles and dot-directories."),
    includeFiles: z
      .boolean()
      .default(true)
      .describe("When false, only directories are shown."),
  }),
  execute: async ({
    startPath = ".",
    maxDepth = 3,
    includeHidden = false,
    includeFiles = true,
  }) => {
    const { absolute, relative } = resolveWorkspacePath(startPath);
    const lines = [relative === "." ? "." : relative];

    const treeLines = await buildTreeLines(absolute, "", 1, {
      maxDepth,
      includeHidden,
      includeFiles,
    });

    lines.push(...treeLines);

    return {
      root: relative === "" ? "." : relative,
      maxDepth,
      includeHidden,
      includeFiles,
      structure: lines.join("\n"),
    };
  },
});

async function buildTreeLines(
  currentDir: string,
  prefix: string,
  depth: number,
  options: TreeOptions,
): Promise<string[]> {
  if (depth > options.maxDepth) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return [`${prefix}|-- [unreadable]`];
  }

  const filtered = entries
    .filter((entry) => {
      if (!options.includeHidden && isHiddenName(entry.name)) {
        return false;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        return false;
      }

      return entry.isDirectory() || options.includeFiles;
    })
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  const lines: string[] = [];

  for (let index = 0; index < filtered.length; index++) {
    const entry = filtered[index]!;
    const isLast = index === filtered.length - 1;
    const nextPrefix = prefix + (isLast ? "    " : "|   ");
    const connector = isLast ? "\\-- " : "|-- ";
    const absoluteEntryPath = path.join(currentDir, entry.name);
    const label = entry.isDirectory() ? `${entry.name}/` : entry.name;

    lines.push(`${prefix}${connector}${label}`);

    if (entry.isDirectory()) {
      lines.push(
        ...(await buildTreeLines(
          absoluteEntryPath,
          nextPrefix,
          depth + 1,
          options,
        )),
      );
    }
  }

  if (lines.length === 0 && depth === 1) {
    lines.push(`${prefix}\\-- [empty]`);
  }

  return lines;
}

