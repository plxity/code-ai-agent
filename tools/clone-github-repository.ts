import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveWorkspacePath, safeStat } from "./utils";

const execFileAsync = promisify(execFile);

export const cloneGitHubRepositoryTool = tool({
  description:
    "Clones a GitHub repository into the current workspace so other tools can inspect it.",
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
      .default(1)
      .describe("Depth for the git clone. Defaults to 1 for shallow clones."),
    destinationDir: z
      .string()
      .optional()
      .describe("Custom subdirectory under the workspace to clone into."),
    force: z
      .boolean()
      .default(false)
      .describe("When true, delete any existing clone at the destination path."),
  }),
  execute: async ({
    repository,
    branch,
    depth = 1,
    destinationDir,
    force = false,
  }) => {
    const { owner, repo } = parseRepository(repository);
    const safeSlug = `${sanitize(owner)}__${sanitize(repo)}`;
    const relativeTarget = destinationDir?.trim()
      ? destinationDir.trim()
      : path.join("external-repos", safeSlug);

    const { absolute, relative } = resolveWorkspacePath(relativeTarget);

    const existing = await safeStat(absolute);
    if (existing) {
      if (!force) {
        return {
          repository: `${owner}/${repo}`,
          path: relative,
          branch,
          depth,
          alreadyExists: true,
          message:
            "Repository already cloned. Provide `force: true` or a different `destinationDir` to re-clone.",
        };
      }

      await fs.rm(absolute, { recursive: true, force: true });
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const cloneArgs = ["clone", "--depth", String(depth)];
    if (branch?.trim()) {
      cloneArgs.push("--branch", branch.trim());
    }
    cloneArgs.push(`https://github.com/${owner}/${repo}.git`, absolute);

    try {
      await execFileAsync("git", cloneArgs, {
        env: process.env,
      });
    } catch (error) {
      throw new Error(
        `Failed to clone repository. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const commit = await runGitCommand(absolute, ["rev-parse", "HEAD"]);
    const activeBranch =
      branch?.trim() ||
      (await runGitCommand(absolute, ["rev-parse", "--abbrev-ref", "HEAD"]));

    return {
      repository: `${owner}/${repo}`,
      path: relative,
      branch: activeBranch || null,
      commit,
      depth,
      message: "Repository cloned successfully.",
    };
  },
});

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
    const { stdout } = await execFileAsync(
      "git",
      ["-C", targetDir, ...args],
      {
        env: process.env,
      },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}


