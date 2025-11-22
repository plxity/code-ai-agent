import path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "@ai-sdk/provider-utils";
import { embedMany } from "ai";
import { z } from "zod";

import {
  DEFAULT_EMBEDDING_MODEL,
  replaceRepoEmbeddings,
  isVectorStoreConfigured,
  repoEmbeddingsUpToDate,
} from "@/lib/vector-store";
import {
  TEXT_FILE_EXTENSIONS,
  readTextFile,
  resolveWorkspacePath,
  walkWorkspaceFiles,
} from "./utils";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_CHUNKS = 2_000;
const DEFAULT_CHUNK_SIZE = 1_200;
const DEFAULT_CHUNK_OVERLAP = 200;
const MAX_FILE_BYTES = 200_000;
const EMBEDDING_BATCH_SIZE = 96;
const EMBEDDING_SKIP_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pnpm-workspace.yaml",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "go.sum",
  "go.mod",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "cargo.lock",
  "environment.yml",
  "environment.yaml",
]);
const EMBEDDING_SKIP_EXTENSIONS = new Set([".lock", ".lockb"]);
const EMBEDDING_SKIP_BASENAME_MATCHERS = [
  (name: string) => name.startsWith("requirements") && name.endsWith(".txt"),
  (name: string) => name.startsWith("constraints") && name.endsWith(".txt"),
];

type ChunkPayload = {
  chunkIndex: number;
  filePath: string;
  content: string;
};

const indexRepositoryEmbeddingsInputSchema = z.object({
  repoSlug: z
    .string()
    .min(3)
    .describe("Repository identifier, typically `owner/name`."),
  repoPath: z
    .string()
    .min(1)
    .describe(
      "Path to the repository root relative to the workspace (e.g., external-repos/owner__repo).",
    ),
  branch: z
    .string()
    .optional()
    .describe("Branch name associated with this snapshot."),
  commitSha: z
    .string()
    .optional()
    .describe("Commit SHA associated with this snapshot."),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(2_000)
    .default(DEFAULT_MAX_FILES)
    .describe("Maximum number of files to index."),
  maxChunks: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(DEFAULT_MAX_CHUNKS)
    .describe("Maximum number of chunks to embed for this run."),
  chunkSize: z
    .number()
    .int()
    .min(200)
    .max(2_400)
    .default(DEFAULT_CHUNK_SIZE)
    .describe("Character count per chunk before overlap."),
  chunkOverlap: z
    .number()
    .int()
    .min(0)
    .max(1_200)
    .default(DEFAULT_CHUNK_OVERLAP)
    .describe("Number of characters shared between sequential chunks."),
  embeddingModel: z
    .string()
    .default(DEFAULT_EMBEDDING_MODEL)
    .describe("Embedding model identifier to use."),
  forceReindex: z
    .boolean()
    .optional()
    .describe(
      "When true, always regenerate embeddings even if the commit is already stored.",
    ),
});

export type IndexRepositoryEmbeddingsInput = z.infer<
  typeof indexRepositoryEmbeddingsInputSchema
>;

export const indexRepositoryEmbeddingsTool = tool({
  description:
    "Indexes a cloned repository into the pgvector store by chunking text files, generating embeddings, and storing them for fast semantic search.",
  inputSchema: indexRepositoryEmbeddingsInputSchema,
  execute: indexRepositoryEmbeddings,
});

export async function indexRepositoryEmbeddings({
  repoSlug,
  repoPath,
  branch,
  commitSha,
  maxFiles = DEFAULT_MAX_FILES,
  maxChunks = DEFAULT_MAX_CHUNKS,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  forceReindex = false,
}: IndexRepositoryEmbeddingsInput) {
  console.log(
    "[index_repository_embeddings] starting",
    JSON.stringify(
      {
        repoSlug,
        repoPath,
        branch,
        commitSha,
        maxFiles,
        maxChunks,
        chunkSize,
        chunkOverlap,
        embeddingModel,
      },
      null,
      2,
    ),
  );

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required to generate embeddings.");
    }

    if (!isVectorStoreConfigured()) {
      throw new Error(
        "Vector store is not configured. Set PGVECTOR_DATABASE_URL (or DATABASE_URL) before indexing.",
      );
    }

    if (chunkOverlap >= chunkSize) {
      throw new Error("`chunkOverlap` must be smaller than `chunkSize`.");
    }

    if (!forceReindex && commitSha) {
      const alreadyIndexed = await repoEmbeddingsUpToDate({
        repoSlug,
        commitSha,
        embeddingModel,
      });

      if (alreadyIndexed) {
        const { relative: repoRelative } = resolveWorkspacePath(repoPath);
        const summary = {
          repoSlug,
          repoPath: repoRelative,
          branch: branch ?? null,
          commitSha,
          filesIndexed: 0,
          chunksIndexed: 0,
          skippedFiles: [],
          embeddingModel,
          message: "Embeddings already exist for this commit. Skipping reindex.",
          skipped: true,
        };

        console.log(
          "[index_repository_embeddings] skip existing",
          JSON.stringify(summary, null, 2),
        );

        return summary;
      }
    }

    const { absolute: repoAbsolute, relative: repoRelative } =
      resolveWorkspacePath(repoPath);

    console.log(
      "[index_repository_embeddings] scanning files",
      JSON.stringify({ repoAbsolute, maxFiles }, null, 2),
    );

    const candidateFiles = await walkWorkspaceFiles({
      startPath: repoAbsolute,
      extensions: TEXT_FILE_EXTENSIONS,
      maxFiles,
    });

    console.log(
      "[index_repository_embeddings] scan complete",
      JSON.stringify({ repoSlug, candidateCount: candidateFiles.length }, null, 2),
    );

    if (candidateFiles.length === 0) {
      return {
        repoSlug,
        repoPath: repoRelative,
        filesIndexed: 0,
        chunksIndexed: 0,
        message: "No text files found to index.",
      };
    }

    const chunkRecords: ChunkPayload[] = [];
    let filesVisited = 0;
    const skippedFiles: string[] = [];

    for (const absoluteFilePath of candidateFiles) {
      if (chunkRecords.length >= maxChunks) break;

      const relativeToRepo = normalizePath(
        path.relative(repoAbsolute, absoluteFilePath) ||
          path.basename(absoluteFilePath),
      );

      if (shouldSkipForEmbedding(relativeToRepo)) {
        skippedFiles.push(relativeToRepo);
        continue;
      }

      let fileContent: string | null = null;
      try {
        const { content } = await readTextFile(absoluteFilePath, MAX_FILE_BYTES);
        fileContent = content;
      } catch (error) {
        console.warn(
          "[index_repository_embeddings] read failed, skipping file",
          JSON.stringify(
            {
              repoSlug,
              file: absoluteFilePath,
              message: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
        skippedFiles.push(relativeToRepo);
        continue;
      }

      const fileChunks = chunkContent(fileContent, chunkSize, chunkOverlap);

      if (!fileChunks.length) {
        skippedFiles.push(relativeToRepo);
        continue;
      }

      for (const chunk of fileChunks) {
        if (chunkRecords.length >= maxChunks) break;
        chunkRecords.push({
          filePath: relativeToRepo,
          chunkIndex: chunk.chunkIndex,
          content: chunk.text,
        });
      }

      filesVisited += 1;
    }

    console.log(
      "[index_repository_embeddings] chunking summary",
      JSON.stringify(
        {
          repoSlug,
          filesVisited,
          chunkRecords: chunkRecords.length,
          skippedFiles: skippedFiles.length,
        },
        null,
        2,
      ),
    );

    if (chunkRecords.length === 0) {
      return {
        repoSlug,
        repoPath: repoRelative,
        filesIndexed: 0,
        chunksIndexed: 0,
        message:
          "No eligible chunks to index. Files may have been empty or binary.",
      };
    }

    const embeddings: number[][] = [];
    const embeddingValues = chunkRecords.map((chunk) => chunk.content);
    const embeddingModelRef = openai.embedding(embeddingModel);

    console.log(
      "[index_repository_embeddings] embedding batches",
      JSON.stringify(
        {
          repoSlug,
          totalChunks: chunkRecords.length,
          batchSize: EMBEDDING_BATCH_SIZE,
        },
        null,
        2,
      ),
    );

    for (
      let index = 0;
      index < embeddingValues.length;
      index += EMBEDDING_BATCH_SIZE
    ) {
      const batch = embeddingValues.slice(index, index + EMBEDDING_BATCH_SIZE);
      const { embeddings: batchEmbeddings } = await embedMany({
        model: embeddingModelRef,
        values: batch,
      });
      embeddings.push(...batchEmbeddings);
      console.log(
        "[index_repository_embeddings] batch embedded",
        JSON.stringify(
          {
            repoSlug,
            processed: Math.min(index + EMBEDDING_BATCH_SIZE, embeddingValues.length),
            total: embeddingValues.length,
          },
          null,
          2,
        ),
      );
    }

    if (embeddings.length !== chunkRecords.length) {
      throw new Error("Embedding count mismatch. Aborting indexing.");
    }

    console.log(
      "[index_repository_embeddings] writing to vector store",
      JSON.stringify(
        { repoSlug, rows: chunkRecords.length, embeddingModel },
        null,
        2,
      ),
    );

    const chunksWithEmbeddings = chunkRecords.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index]!,
    }));

    await replaceRepoEmbeddings({
      repoSlug,
      branch,
      commitSha,
      embeddingModel,
      chunks: chunksWithEmbeddings,
    });

    const summary = {
      repoSlug,
      repoPath: repoRelative,
      branch: branch ?? null,
      commitSha: commitSha ?? null,
      filesIndexed: filesVisited,
      chunksIndexed: chunkRecords.length,
      skippedFiles,
      embeddingModel,
    };

    console.log(
      "[index_repository_embeddings] completed",
      JSON.stringify(summary, null, 2),
    );

    return summary;
  } catch (error) {
    console.error(
      "[index_repository_embeddings] failed",
      JSON.stringify(
        {
          repoSlug,
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

function chunkContent(
  content: string,
  chunkSize: number,
  chunkOverlap: number,
) {
  const normalized = content.replace(/\r\n/g, "\n");
  const stride = Math.max(1, chunkSize - chunkOverlap);
  const chunks: Array<{ text: string; chunkIndex: number }> = [];

  let start = 0;
  let chunkIndex = 0;

  while (start < normalized.length) {
    const raw = normalized.slice(start, start + chunkSize);
    const text = raw.trim();
    if (text.length > 0) {
      chunks.push({ text, chunkIndex });
      chunkIndex += 1;
    }

    start += stride;
  }

  return chunks;
}

function normalizePath(target: string) {
  return target.split(path.sep).join("/");
}

function shouldSkipForEmbedding(relativePath: string) {
  const basename = path.basename(relativePath).toLowerCase();
  if (EMBEDDING_SKIP_BASENAMES.has(basename)) {
    return true;
  }

  if (EMBEDDING_SKIP_BASENAME_MATCHERS.some((matcher) => matcher(basename))) {
    return true;
  }

  if (EMBEDDING_SKIP_EXTENSIONS.has(path.extname(basename))) {
    return true;
  }

  return false;
}

