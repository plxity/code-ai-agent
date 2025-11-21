import { promises as fs } from "node:fs";
import path from "node:path";

export const WORKSPACE_ROOT = process.env.CODE_AGENT_ROOT
  ? path.resolve(process.env.CODE_AGENT_ROOT)
  : process.cwd();

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "node_modules",
  ".turbo",
  ".vercel",
  "out",
  "dist",
  "build",
  ".cache",
]);

export const TEXT_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".css",
  ".scss",
  ".sass",
  ".html",
  ".txt",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
]);

export function isHiddenName(name: string) {
  return name.startsWith(".");
}

export function toRelativePath(absolutePath: string) {
  const relative = path.relative(WORKSPACE_ROOT, absolutePath);
  return relative === "" ? "." : relative;
}

export function resolveWorkspacePath(targetPath = ".") {
  const normalized = targetPath.replace(/^~\/?/, "");
  const resolved = path.resolve(WORKSPACE_ROOT, normalized);

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error("Path escapes the repository root.");
  }

  return {
    absolute: resolved,
    relative: toRelativePath(resolved),
  };
}

export async function safeStat(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

export async function readTextFile(
  targetPath: string,
  maxBytes = 200_000,
  encoding: BufferEncoding = "utf8",
) {
  const fileBuffer = await fs.readFile(targetPath);
  const truncated =
    maxBytes !== undefined && fileBuffer.byteLength > maxBytes
      ? fileBuffer.subarray(0, maxBytes)
      : fileBuffer;

  return {
    content: truncated.toString(encoding),
    truncated: truncated.byteLength < fileBuffer.byteLength,
    sizeInBytes: fileBuffer.byteLength,
  };
}

type WalkFilesOptions = {
  startPath?: string;
  includeHidden?: boolean;
  extensions?: Set<string>;
  maxFiles?: number;
};

export async function walkWorkspaceFiles({
  startPath = ".",
  includeHidden = false,
  extensions,
  maxFiles = 500,
}: WalkFilesOptions = {}) {
  const { absolute } = resolveWorkspacePath(startPath);
  const stack: string[] = [absolute];
  const results: string[] = [];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!includeHidden && isHiddenName(entry.name)) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absoluteEntryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(absoluteEntryPath);
        continue;
      }

      if (extensions && extensions.size > 0) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.has(ext)) continue;
      }

      results.push(absoluteEntryPath);
      if (results.length >= maxFiles) return results;
    }
  }

  return results;
}

export function globToRegExp(pattern: string) {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");

  return new RegExp(`^${regexBody}$`, "i");
}

export function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
}

