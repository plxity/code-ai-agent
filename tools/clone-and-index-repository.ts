import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { indexRepositoryEmbeddings } from "./index-repository-embeddings";
import { resolveWorkspacePath, safeStat } from "./utils";

const CLONE_DEFAULT_DEPTH = 1;
const execFileAsync = promisify(execFile);

export const cloneAndIndexRepositoryTool = tool({
  description:
    "Clones a GitHub repository into the workspace and immediately indexes embeddings into pgvector so semantic tools can query it.",
  inputSchema: z.object({
    repository: z
      .string()
      .min(3)
      .describe("Repository in `owner/name` form or a full GitHub URL."),
    branch: z
      .string()
      .optional()
      .describe("Branch or tag to checkout after cloning."),
    depth: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(CLONE_DEFAULT_DEPTH)
      .describe("Depth for git clone."),
    destinationDir: z
      .string()
      .optional()
      .describe("Custom subdirectory under the workspace to clone into."),
    force: z
      .boolean()
      .default(false)
      .describe("When true, delete existing clone before re-cloning."),
    maxFiles: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .default(600)
      .describe("Maximum files to include when indexing embeddings."),
    maxChunks: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(2_000)
      .describe("Maximum chunks to embed per indexing run."),
    chunkSize: z
      .number()
      .int()
      .min(200)
      .max(2_400)
      .default(1_200)
      .describe("Character count per chunk before overlap."),
    chunkOverlap: z
      .number()
      .int()
      .min(0)
      .max(1_200)
      .default(200)
      .describe("Number of overlapping characters between sequential chunks."),
    embeddingModel: z
      .string()
      .optional()
      .describe("Override embedding model. Defaults to text-embedding-3-small."),
  }),
  execute: async (input) => {
    const {
      repository,
      branch,
      depth = CLONE_DEFAULT_DEPTH,
      destinationDir,
      force = false,
      maxFiles,
      maxChunks,
      chunkSize,
      chunkOverlap,
      embeddingModel,
    } = input;

    console.log(
      "[clone_and_index_repository] starting",
      JSON.stringify({ repository, branch, destinationDir, force }, null, 2),
    );

    const cloneResult = await cloneRepository({
      repository,
      branch,
      depth,
      destinationDir,
      force,
    });

    if (!cloneResult.path) {
      throw new Error(
        "Clone completed but did not return a repository path. Cannot proceed with indexing.",
      );
    }

    const repoSlug = cloneResult.repository;
    const repoPath = cloneResult.path;

    console.log(
      "[clone_and_index_repository] cloned",
      JSON.stringify(
        {
          repository: cloneResult.repository,
          branch: cloneResult.branch,
          path: cloneResult.path,
          alreadyExists: cloneResult.alreadyExists ?? false,
        },
        null,
        2,
      ),
    );

    const indexingResult = await indexRepositoryEmbeddings({
      repoSlug,
      repoPath,
      branch: cloneResult.branch ?? branch,
      commitSha: cloneResult.commit ?? undefined,
      maxFiles,
      maxChunks,
      chunkSize,
      chunkOverlap,
      embeddingModel,
    });

    console.log(
      "[clone_and_index_repository] indexed",
      JSON.stringify(
        {
          repository: repoSlug,
          filesIndexed: indexingResult.filesIndexed,
          chunksIndexed: indexingResult.chunksIndexed,
        },
        null,
        2,
      ),
    );

    return {
      repository: repoSlug,
      repoPath,
      branch: indexingResult.branch,
      commitSha: indexingResult.commitSha,
      clone: cloneResult,
      indexing: indexingResult,
    };
  },
});

async function cloneRepository({
  repository,
  branch,
  depth,
  destinationDir,
  force,
}: {
  repository: string;
  branch?: string;
  depth?: number;
  destinationDir?: string;
  force?: boolean;
}) {
  const parsed = parseRepository(repository);
  const safeSlug = `${sanitize(parsed.owner)}__${sanitize(parsed.repo)}`;
  const relativeTarget = destinationDir?.trim()
    ? destinationDir.trim()
    : path.join("external-repos", safeSlug);

  const { absolute, relative } = resolveWorkspacePath(relativeTarget);
  const existing = await safeStat(absolute);

  if (existing) {
    if (!force) {
      return {
        repository: `${parsed.owner}/${parsed.repo}`,
        path: relative,
        branch: branch ?? null,
        commit: await runGitCommand(absolute, ["rev-parse", "HEAD"]),
        alreadyExists: true,
        message:
          "Repository already exists locally. Provide `force: true` or a different `destinationDir` to re-clone.",
      };
    }
    await fs.rm(absolute, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(absolute), { recursive: true });

  const cloneArgs = ["clone", `--depth`, String(depth ?? CLONE_DEFAULT_DEPTH)];
  if (branch?.trim()) {
    cloneArgs.push("--branch", branch.trim());
  }

  cloneArgs.push(
    `https://github.com/${parsed.owner}/${parsed.repo}.git`,
    absolute,
  );

  await execFileAsync("git", cloneArgs);

  const activeBranch =
    branch?.trim() ||
    (await runGitCommand(absolute, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const commitSha = await runGitCommand(absolute, ["rev-parse", "HEAD"]);

  return {
    repository: `${parsed.owner}/${parsed.repo}`,
    path: relative,
    branch: activeBranch,
    commit: commitSha,
  };
}

function parseRepository(input: string) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?/i,
  );

  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/, ""),
    };
  }

  const normalized = trimmed.replace(/^\/+|\/+$/g, "");
  const [owner, repo] = normalized.split("/");

  if (owner && repo) {
    return {
      owner,
      repo: repo.replace(/\.git$/, ""),
    };
  }

  throw new Error(
    "Repository must be provided as `owner/name` or a valid GitHub URL.",
  );
}

function sanitize(value: string) {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

async function runGitCommand(targetDir: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetDir, ...args]);
    return stdout.trim();
  } catch {
    return null;
  }
}

