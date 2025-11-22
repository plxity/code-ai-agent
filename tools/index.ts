import type { ToolSet } from "ai";

import { generateFileStructureTool } from "./generate-file-structure";
import { getGitHistoryTool } from "./get-git-history";
import { indexRepositoryEmbeddingsTool } from "./index-repository-embeddings";
import { readFileTool } from "./read-file";
import { searchByFileTool } from "./search-by-file";
import { searchByKeywordTool } from "./search-by-keyword";
import { searchVectorEmbeddingsTool } from "./search-vector-embeddings";
import { searchSemanticTool } from "./search-semantic";
import { cloneAndIndexRepositoryTool } from "./clone-and-index-repository";
import { summarizeSnippetsTool } from "./summarize-snippets";

export const agentTools = {
  clone_and_index_repository: cloneAndIndexRepositoryTool,
  generate_file_structure: generateFileStructureTool,
  read_file: readFileTool,
  search_by_keyword: searchByKeywordTool,
  search_by_file: searchByFileTool,
  search_semantic: searchSemanticTool,
  get_git_history: getGitHistoryTool,
  index_repository_embeddings: indexRepositoryEmbeddingsTool,
  search_vector_embeddings: searchVectorEmbeddingsTool,
  summarize_snippets: summarizeSnippetsTool,
} satisfies ToolSet;

export type AgentToolSet = typeof agentTools;

export {
  cloneAndIndexRepositoryTool,
  generateFileStructureTool,
  getGitHistoryTool,
  indexRepositoryEmbeddingsTool,
  readFileTool,
  searchByFileTool,
  searchByKeywordTool,
  searchVectorEmbeddingsTool,
  searchSemanticTool,
  summarizeSnippetsTool,
};

