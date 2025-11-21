import type { ToolSet } from "ai";

import { cloneGitHubRepositoryTool } from "./clone-github-repository";
import { generateFileStructureTool } from "./generate-file-structure";
import { getGitHistoryTool } from "./get-git-history";
import { readFileTool } from "./read-file";
import { searchByFileTool } from "./search-by-file";
import { searchByKeywordTool } from "./search-by-keyword";
import { searchSemanticTool } from "./search-semantic";

export const agentTools = {
  clone_github_repository: cloneGitHubRepositoryTool,
  generate_file_structure: generateFileStructureTool,
  read_file: readFileTool,
  search_by_keyword: searchByKeywordTool,
  search_by_file: searchByFileTool,
  search_semantic: searchSemanticTool,
  get_git_history: getGitHistoryTool,
} satisfies ToolSet;

export type AgentToolSet = typeof agentTools;

export {
  cloneGitHubRepositoryTool,
  generateFileStructureTool,
  getGitHistoryTool,
  readFileTool,
  searchByFileTool,
  searchByKeywordTool,
  searchSemanticTool,
};

