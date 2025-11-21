import { tool } from "@ai-sdk/provider-utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { WORKSPACE_ROOT, resolveWorkspacePath } from "./utils";

const execFileAsync = promisify(execFile);

export const getGitHistoryTool = tool({
  description:
    "Returns recent git commits for a given file, optionally including the diff.",
  inputSchema: z.object({
    filePath: z
      .string()
      .min(1)
      .describe("Path to the file whose history should be inspected."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of commits to return."),
    includeDiff: z
      .boolean()
      .default(false)
      .describe("Attach a short diff for the most recent commits (max 3)."),
  }),
  execute: async ({ filePath, limit = 5, includeDiff = false }) => {
    const { relative } = resolveWorkspacePath(filePath);

    const format = "%H|%h|%an|%ad|%s";

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "git",
        [
          "log",
          `-n`,
          String(limit),
          "--date=iso-strict",
          `--pretty=format:${format}`,
          "--",
          relative,
        ],
        { cwd: WORKSPACE_ROOT },
      ));
    } catch (error) {
      return {
        file: relative,
        error:
          "Unable to read git history. Ensure this project is a git repository and the file is tracked.",
        details: error instanceof Error ? error.message : String(error),
      };
    }

    if (!stdout.trim()) {
      return {
        file: relative,
        commits: [],
        message: "No git history found for this path.",
      };
    }

    const commits = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, date, ...subjectParts] = line.split("|");
        return {
          hash,
          shortHash,
          author,
          date,
          subject: subjectParts.join("|"),
        };
      });

    if (includeDiff) {
      const diffTargets = commits.slice(0, Math.min(commits.length, 3));

      await Promise.all(
        diffTargets.map(async (commit) => {
          try {
            const { stdout: diff } = await execFileAsync(
              "git",
              [
                "show",
                commit.hash,
                "--stat",
                "--color=never",
                "--",
                relative,
              ],
              { cwd: WORKSPACE_ROOT, maxBuffer: 2 * 1024 * 1024 },
            );

            Object.assign(commit, {
              diff: diff.slice(0, 60_000),
            });
          } catch (error) {
            Object.assign(commit, {
              diffError:
                error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }

    return {
      file: relative,
      commits,
      limit,
      includeDiff,
    };
  },
});

