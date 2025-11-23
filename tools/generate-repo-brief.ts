import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "@ai-sdk/provider-utils";
import { streamText } from "ai";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  resolveWorkspacePath,
  safeStat,
  isHiddenName,
  IGNORED_DIRECTORIES,
  toRelativePath,
} from "./utils";

const execFileAsync = promisify(execFile);
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TREE_MAX_ITEMS = 80;
const SNIPPET_LIMIT = 4_000;
const MAX_IMPORTANT_SNIPPETS = 5;
const DEFAULT_OUTPUT_FILE = "AI_SUMMARY.md";

const IMPORTANT_FILES = [
  "README.md",
  "docs/README.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "DEVELOPMENT.md",
  "docs/ARCHITECTURE.md",
  "docs/overview.md",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
  "mix.exs",
  "mix.lock",
];

export const generateRepoBriefTool = tool({
  description:
    "Generates a technical summary for a cloned repository (architecture overview, key files, recent commits) and writes it to AI_SUMMARY.md under the repo.",
  inputSchema: z.object({
    repoSlug: z
      .string()
      .min(3)
      .describe("Repository identifier, typically owner/name."),
    repoPath: z
      .string()
      .min(1)
      .describe(
        "Path to the repository root relative to the workspace (e.g., external-repos/owner__repo).",
      ),
    outputFile: z
      .string()
      .optional()
      .describe(
        `Filename for the generated brief. Defaults to ${DEFAULT_OUTPUT_FILE}.`,
      ),
    treeDepth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("Depth of the directory tree preview to capture."),
    includeRecentCommits: z
      .boolean()
      .default(true)
      .describe("Whether to include the latest git commits in the summary."),
  }),
  execute: async ({
    repoSlug,
    repoPath,
    outputFile = DEFAULT_OUTPUT_FILE,
    treeDepth = 3,
    includeRecentCommits,
  }) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required to generate repo briefs.");
    }

    const { absolute: repoAbsolute, relative: repoRelative } =
      resolveWorkspacePath(repoPath);
    const stats = await safeStat(repoAbsolute);
    if (!stats || !stats.isDirectory()) {
      throw new Error(
        `Repository path "${repoPath}" does not exist. Try cloning it first.`,
      );
    }

    const treePreview = await buildTreePreview({
      root: repoAbsolute,
      maxDepth: treeDepth,
    });

    const importantSnippets = await readImportantFiles(repoAbsolute);

    const recentCommits = includeRecentCommits
      ? await getRecentCommits(repoAbsolute)
      : "Recent commits skipped.";

    const richPrompt = buildPrompt({
      repoSlug,
      repoRelative,
      treePreview,
      importantSnippets,
      recentCommits,
    });

    let summaryText = await generateBriefText(richPrompt);

    if (!summaryText) {
      const fallbackPrompt = buildPrompt({
        repoSlug,
        repoRelative,
        treePreview,
        importantSnippets: [],
        recentCommits,
        short: true,
      });
      summaryText = await generateBriefText(fallbackPrompt);
    }

    if (!summaryText) {
      summaryText = buildDeterministicFallback({
        repoSlug,
        repoRelative,
        treePreview,
        importantFiles: importantSnippets.map((snippet) => snippet.filePath),
        recentCommits,
      });
    }

    const outputAbsolute = path.join(repoAbsolute, outputFile);
    await fs.writeFile(outputAbsolute, summaryText, "utf8");

    return {
      repoSlug,
      repoPath: repoRelative,
      outputFile: toRelativePath(outputAbsolute),
      bytesWritten: Buffer.byteLength(summaryText, "utf8"),
      snippetCount: importantSnippets.length,
      includedCommits: includeRecentCommits,
    };
  },
});

async function buildTreePreview({
  root,
  maxDepth,
}: {
  root: string;
  maxDepth: number;
}) {
  const lines: string[] = [];
  const stack: Array<{ dir: string; prefix: string; depth: number }> = [
    { dir: root, prefix: "", depth: 1 },
  ];

  while (stack.length && lines.length < TREE_MAX_ITEMS) {
    const { dir, prefix, depth } = stack.pop()!;
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      lines.push(`${prefix}|-- [unreadable]`);
      continue;
    }

    const filtered = entries
      .filter((entry) => {
        if (IGNORED_DIRECTORIES.has(entry.name)) return false;
        if (isHiddenName(entry.name)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    filtered.forEach((entry, index) => {
      const isLast = index === filtered.length - 1;
      const connector = isLast ? "\\-- " : "|-- ";
      const entryLabel = entry.isDirectory()
        ? `${entry.name}/`
        : entry.name;
      const line = `${prefix}${connector}${entryLabel}`;
      lines.push(line);

      if (
        entry.isDirectory() &&
        depth < maxDepth &&
        lines.length < TREE_MAX_ITEMS
      ) {
        stack.push({
          dir: path.join(dir, entry.name),
          prefix: prefix + (isLast ? "    " : "|   "),
          depth: depth + 1,
        });
      }
    });
  }

  return lines.length ? lines.join("\n") : "[empty]";
}

async function readImportantFiles(root: string) {
  const snippets: Array<{ filePath: string; content: string }> = [];

  for (const relativePath of IMPORTANT_FILES) {
    const absolutePath = path.join(root, relativePath);
    const fileStats = await safeStat(absolutePath);
    if (!fileStats || !fileStats.isFile()) continue;

    const fileContent = await fs.readFile(absolutePath, "utf8");
    const trimmedContent =
      fileContent.length > SNIPPET_LIMIT
        ? `${fileContent.slice(0, SNIPPET_LIMIT)}\n[...truncated...]`
        : fileContent;
    snippets.push({
      filePath: relativePath,
      content: trimmedContent,
    });

    if (snippets.length >= MAX_IMPORTANT_SNIPPETS) {
      break;
    }
  }

  return snippets;
}

async function getRecentCommits(root: string) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "log",
      "--pretty=format:* %h %ad %an — %s",
      "--date=short",
      "-n",
      "5",
    ]);
    return stdout.trim();
  } catch (error) {
    return `Unable to read git history: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function buildPrompt({
  repoSlug,
  repoRelative,
  treePreview,
  importantSnippets,
  recentCommits,
  short = false,
}: {
  repoSlug: string;
  repoRelative: string;
  treePreview: string;
  importantSnippets: Array<{ filePath: string; content: string }>;
  recentCommits: string;
  short?: boolean;
}) {
  const sections: string[] = [
    `Repository: ${repoSlug}`,
    `Relative Path: ${repoRelative}`,
    "",
    "=== Directory Structure Preview ===",
    treePreview,
  ];

  if (!short) {
    sections.push(
      "",
      "=== Important Files ===",
      importantSnippets.length
        ? importantSnippets
            .map(
              (snippet, index) =>
                `Snippet ${index + 1}: ${snippet.filePath}\n${snippet.content}`,
            )
            .join("\n\n")
        : "No key files were found (README, docs, manifests).",
    );
  }

  sections.push(
    "",
    "=== Recent Commits ===",
    recentCommits.trim().length ? recentCommits : "No commits available.",
    "",
    "Task: Write a concise, well-structured technical brief (Markdown) covering:",
    "- Repository overview & purpose",
    "- Key components / directories (reference paths explicitly)",
    "- Build / run insights if available",
    "- Recent changes worth noting",
    "- Outstanding questions or TODOs if information is missing",
    short
      ? "Keep it under ~250 words and focus on high-level structure."
      : "Keep it under ~400 words and cite file paths or commit hashes in parentheses.",
  );

  return sections.join("\n");
}

async function generateBriefText(prompt: string) {
  try {
    const result = await streamText({
      model: openai("gpt-5.1"),
      system:
        "You are an engineering copilot crafting repository briefs. Be accurate, grounded in the provided snippets, and use Markdown headings.",
      prompt,
      maxRetries: 1,
    });
    const text = (await result.text)?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.warn("generate_repo_brief LLM call failed:", error);
    return null;
  }
}

function buildDeterministicFallback({
  repoSlug,
  repoRelative,
  treePreview,
  importantFiles,
  recentCommits,
}: {
  repoSlug: string;
  repoRelative: string;
  treePreview: string;
  importantFiles: string[];
  recentCommits: string;
}) {
  const lines: string[] = [
    `# ${repoSlug} — Automated Brief`,
    "",
    `- Path: ${repoRelative}`,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Directory Snapshot",
    "```\n" + treePreview + "\n```",
    "",
    "## Key Files",
    importantFiles.length
      ? importantFiles.map((file) => `- ${file}`).join("\n")
      : "- No signature docs (README, architecture files) were detected.",
    "",
    "## Recent Commits",
    recentCommits.trim().length ? recentCommits : "No git history available.",
    "",
    "_This fallback summary was generated without LLM output. Consider running `generate_repo_brief` again once the repo stabilizes for a richer brief._",
  ];

  return lines.join("\n");
}


