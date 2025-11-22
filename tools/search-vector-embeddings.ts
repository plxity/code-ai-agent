import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "@ai-sdk/provider-utils";
import { embed } from "ai";
import { z } from "zod";

import {
  DEFAULT_EMBEDDING_MODEL,
  vectorSimilaritySearch,
} from "@/lib/vector-store";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const searchVectorEmbeddingsTool = tool({
  description:
    "Runs a semantic search over previously indexed repository chunks stored in pgvector.",
  inputSchema: z.object({
    repoSlug: z
      .string()
      .min(3)
      .describe("Repository identifier, typically `owner/name`."),
    query: z.string().min(3).describe("Question or statement to search for."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of matching chunks to return."),
    minScore: z
      .number()
      .min(-1)
      .max(1)
      .default(-1)
      .describe(
        "Minimum cosine similarity score required to include a chunk. Range [-1, 1].",
      ),
    embeddingModel: z
      .string()
      .default(DEFAULT_EMBEDDING_MODEL)
      .describe("Embedding model identifier. Must match the one used for indexing."),
  }),
  execute: async ({
    repoSlug,
    query,
    topK = 5,
    minScore = -1,
    embeddingModel = DEFAULT_EMBEDDING_MODEL,
  }) => {
    console.log(
      "[search_vector_embeddings] start",
      JSON.stringify({ repoSlug, query, topK, minScore, embeddingModel }, null, 2),
    );

    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required to run vector search.");
    }

    const { embedding } = await embed({
      model: openai.embedding(embeddingModel),
      value: query,
    });

    const rows = await vectorSimilaritySearch({
      repoSlug,
      embedding,
      limit: topK,
    });

    const results = rows
      .map((row) => ({
        filePath: row.filePath,
        chunkIndex: row.chunkIndex,
        content: row.content,
        branch: row.branch,
        commitSha: row.commitSha,
        embeddingModel: row.embeddingModel,
        score: typeof row.score === "number" ? Number(row.score.toFixed(4)) : null,
      }))
      .filter((row) => row.score === null || row.score >= minScore);

    return {
      repoSlug,
      query,
      topK,
      minScore,
      embeddingModel,
      results,
    };
  },
});

