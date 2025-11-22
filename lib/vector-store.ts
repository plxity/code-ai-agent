import { Pool, PoolClient } from "pg";
import { registerType } from "pgvector/pg";
import { toSql } from "pgvector/utils";

const VECTOR_CONNECTION_URL =
  process.env.PGVECTOR_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

export const EMBEDDING_DIMENSION = 1_536;
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

let pool: Pool | null = null;

if (VECTOR_CONNECTION_URL) {
  pool = new Pool({
    connectionString: VECTOR_CONNECTION_URL,
  });

  pool.on("connect", async (client: PoolClient) => {
    try {
      await registerType(client);
    } catch (error) {
      console.error("Failed to register pgvector types:", error);
    }
  });
}

function assertVectorPool() {
  if (!pool) {
    throw new Error(
      "Vector store is not configured. Set PGVECTOR_DATABASE_URL (or DATABASE_URL) to a Postgres instance with the pgvector extension.",
    );
  }

  return pool;
}

let schemaInitialized = false;

async function ensureSchema(client: PoolClient) {
  if (schemaInitialized) return;

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (error) {
    throw new Error(
      `Unable to create the pgvector extension. Ensure your database user can run "CREATE EXTENSION vector". Underlying error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS repo_embeddings (
      id BIGSERIAL PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      branch TEXT,
      commit_sha TEXT,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(${EMBEDDING_DIMENSION}) NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(
    `CREATE INDEX IF NOT EXISTS repo_embeddings_repo_slug_idx ON repo_embeddings (repo_slug)`,
  );

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = 'repo_embeddings_vector_idx'
      ) THEN
        CREATE INDEX repo_embeddings_vector_idx
        ON repo_embeddings
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
      END IF;
    END
    $$;
  `);

  schemaInitialized = true;
}

async function withVectorClient<T>(
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const activePool = assertVectorPool();
  const client = await activePool.connect();
  try {
    await ensureSchema(client);
    return await handler(client);
  } finally {
    client.release();
  }
}

type ChunkRecord = {
  filePath: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
};

export async function replaceRepoEmbeddings({
  repoSlug,
  branch,
  commitSha,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  chunks,
}: {
  repoSlug: string;
  branch?: string | null;
  commitSha?: string | null;
  embeddingModel?: string;
  chunks: ChunkRecord[];
}) {
  if (!chunks.length) {
    return { repoSlug, inserted: 0 };
  }

  return withVectorClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM repo_embeddings WHERE repo_slug = $1", [
        repoSlug,
      ]);

      const insertSQL = `
        INSERT INTO repo_embeddings (
          repo_slug,
          branch,
          commit_sha,
          file_path,
          chunk_index,
          content,
          embedding,
          embedding_model
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
      `;

      for (const chunk of chunks) {
        await client.query(insertSQL, [
          repoSlug,
          branch ?? null,
          commitSha ?? null,
          chunk.filePath,
          chunk.chunkIndex,
          chunk.content,
          toSql(chunk.embedding),
          embeddingModel,
        ]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    return { repoSlug, inserted: chunks.length };
  });
}

export async function vectorSimilaritySearch({
  repoSlug,
  embedding,
  limit = 5,
}: {
  repoSlug: string;
  embedding: number[];
  limit?: number;
}) {
  if (!embedding.length) {
    throw new Error("Query embedding is empty.");
  }

  return withVectorClient(async (client) => {
    const { rows } = await client.query<RepoEmbeddingRow>(
      `
        SELECT
          file_path,
          chunk_index,
          content,
          branch,
          commit_sha,
          embedding_model,
          1 - (embedding <#> $2::vector) AS score
        FROM repo_embeddings
        WHERE repo_slug = $1
        ORDER BY embedding <#> $2::vector
        LIMIT $3
      `,
      [repoSlug, toSql(embedding), limit],
    );

    return rows.map((row) => ({
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      content: row.content,
      branch: row.branch,
      commitSha: row.commit_sha,
      embeddingModel: row.embedding_model,
      score: row.score,
    }));
  });
}

export function isVectorStoreConfigured() {
  return Boolean(pool);
}

export async function repoEmbeddingsUpToDate({
  repoSlug,
  commitSha,
  embeddingModel,
}: {
  repoSlug: string;
  commitSha?: string | null;
  embeddingModel?: string;
}) {
  if (!repoSlug.trim() || !commitSha) {
    return false;
  }

  return withVectorClient(async (client) => {
    const conditions = ["repo_slug = $1"];
    const values: Array<string | null> = [repoSlug];
    let paramIndex = 2;

    conditions.push(`commit_sha = $${paramIndex++}`);
    values.push(commitSha);

    if (embeddingModel) {
      conditions.push(`embedding_model = $${paramIndex++}`);
      values.push(embeddingModel);
    }

    const query = `
      SELECT 1
      FROM repo_embeddings
      WHERE ${conditions.join(" AND ")}
      LIMIT 1
    `;

    const { rows } = await client.query(query, values);
    return rows.length > 0;
  });
}

type RepoEmbeddingRow = {
  file_path: string;
  chunk_index: number;
  content: string;
  branch: string | null;
  commit_sha: string | null;
  embedding_model: string;
  score: number | null;
};

