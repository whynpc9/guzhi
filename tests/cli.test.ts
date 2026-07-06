import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI numeric options", () => {
  it("rejects partially numeric values", async () => {
    const result = await runCliExpectFailure("1abc");

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Expected integer, got 1abc");
  });

  it("rejects non-positive values", async () => {
    const result = await runCliExpectFailure("0");

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Expected positive integer, got 0");
  });
});

async function runCliExpectFailure(k: string): Promise<{ code: number | undefined; stderr: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-cli-"));
  try {
    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "--repo",
      root,
      "--data-dir",
      path.join(root, ".guzhi", "db"),
      "--json",
      "search",
      "query",
      "-k",
      k,
    ]);
    throw new Error("Expected CLI command to fail.");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "stderr" in error) {
      return {
        code: typeof error.code === "number" ? error.code : undefined,
        stderr: String(error.stderr),
      };
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
