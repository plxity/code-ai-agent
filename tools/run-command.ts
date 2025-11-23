import { tool } from "@ai-sdk/provider-utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { resolveWorkspacePath, toRelativePath, WORKSPACE_ROOT } from "./utils";

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = new Set([
  "rg",
  "grep",
  "ls",
  "cat",
  "find",
  "sed",
  "awk",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "npx",
  "python",
  "python3",
  "pytest",
  "go",
  "cargo",
  "git",
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

export const runCommandTool = tool({
  description:
    "Executes a whitelisted shell command (rg/grep/git/etc.) inside the repository and streams back stdout/stderr.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .describe("Name of the command to execute (e.g., rg, git, npm)."),
    args: z
      .array(z.string())
      .optional()
      .describe("Arguments to pass to the command."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory relative to the workspace root."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .optional()
      .describe("Execution timeout in milliseconds (default 60s)."),
  }),
  execute: async ({ command, args = [], cwd = ".", timeoutMs }) => {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(
        `Command "${command}" is not allowed. Permitted commands: ${Array.from(
          ALLOWED_COMMANDS,
        ).join(", ")}`,
      );
    }

    const { absolute: resolvedCwd, relative } = resolveWorkspacePath(cwd);

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: resolvedCwd,
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      return {
        command,
        args,
        cwd: relative,
        exitCode: 0,
        stdout,
        stderr,
      };
    } catch (error) {
      if (typeof error === "object" && error && "stdout" in error) {
        const execError = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
          message: string;
        };

        return {
          command,
          args,
          cwd: toRelativePath(resolvedCwd),
          exitCode:
            typeof execError.code === "number" ? execError.code : -1,
          stdout: execError.stdout ?? "",
          stderr: execError.stderr ?? execError.message,
        };
      }

      throw error;
    }
  },
});


