Core Search Flow:

Question Analysis: Take a user question and use an LLM to break it down into a reasoning step
Query Decomposition: Extract key search terms and determine what type of information is needed
Iterative Search: Perform searches and evaluate if additional context is required
Context Synthesis: Combine results and determine if the question can be answered or if more searching is needed
Suggested Tools (feel free to modify or add others):

generate_file_structure() → Returns the codebase file structure as a text string
read_file(file_path) → Returns the complete content of a specified file
search_by_keyword(keywords) → Searches codebase for specific terms
search_by_file(file_pattern) → Finds files matching a pattern
search_semantic(query, repo_slug?) → Semantic search across codebase (uses pgvector embeddings when `repo_slug` is provided and indexed)
get_git_history(file_path) → Recent changes to understand context
clone_github_repository(repository, branch?) → Clones a GitHub repo into `external-repos/` so every local-only tool can inspect it
clone_and_index_repository(...) → Clones a repo and immediately builds pgvector embeddings (one-shot convenience call)
index_repository_embeddings(repo_slug, repo_path, …) → Chunks a cloned repo, generates embeddings, and stores them in pgvector for fast retrieval
search_vector_embeddings(repo_slug, query, topK?) → Runs a pgvector similarity search over previously indexed chunks
Expected Behavior:

Stream the reasoning process back to the user interface (like Cursor's AI chat)
Make intelligent decisions about when to stop searching vs. continue
Handle multi-turn search scenarios where initial results inform follow-up queries
Maintain conversation context and codebase understanding across interactions

Tip: Ensure the host has `git` installed; `clone_github_repository` uses it to place clones under `external-repos/<owner>__<repo>`, after which the usual `read_file`, `search_*`, etc. tools can operate on that path. Set `GITHUB_TOKEN` if you need to clone private repositories or want higher GitHub rate limits.

### Vector search setup

1. Provision Postgres 15+ (local Docker or hosted) and enable the [`pgvector`](https://github.com/pgvector/pgvector) extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
2. Set `PGVECTOR_DATABASE_URL` (or reuse `DATABASE_URL`) to point at that database.
3. After cloning a repo with `clone_github_repository`, call `index_repository_embeddings` to chunk files and store embeddings (requires `OPENAI_API_KEY` for `text-embedding-3-small`).
4. Use `search_vector_embeddings` in later turns to fetch the most relevant chunks before reading full files.

The indexing tool automatically maintains a table named `repo_embeddings` and replaces existing rows for the same repo slug on each run.

## Backend API

`POST /api`

```jsonc
{
  "question": "What tools does this agent have?",
  "temperature": 0.2,
  "maxTokens": 1200
  // OR provide a messages array matching the OpenAI CoreMessage shape:
  // "messages": [
  //   { "role": "user", "content": "Summarize this repository" }
  // ]
}
```

Response:

```json
{
  "answer": "…final model text…",
  "finishReason": "stop",
  "usage": { "promptTokens": 123, "completionTokens": 456, "totalTokens": 579 },
  "toolCalls": [],
  "steps": [],
  "rawResponse": { "messages": [/* model + tool traces */] }
}
```

> Note: The React client shipped in this repo still uses the streaming `useChat` hook and is no longer wired to this endpoint. Exercise the API directly (e.g. curl/Postman) or update the UI to consume the JSON response.