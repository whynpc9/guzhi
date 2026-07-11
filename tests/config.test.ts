import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configForDisplay, loadConfig } from "../src/config.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("environment config", () => {
  it("ignores GUZHI variables that are not known config paths", async () => {
    process.env.GUZHI_DEBUG = "1";
    process.env.GUZHI_EMBEDDING__API_KEY = "secret";
    const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-config-"));
    try {
      const loaded = await loadConfig({ cwd: root, repoRoot: root });
      expect(loaded.config).not.toHaveProperty("debug");
      expect(loaded.config.embedding).not.toHaveProperty("api_key");
      expect(loaded.sources).not.toHaveProperty("debug");
      expect(loaded.sources).not.toHaveProperty("embedding.api_key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets from displayed config without mutating the loaded config", async () => {
    process.env.GUZHI_STORAGE__MILVUS_PASSWORD = "password-value";
    process.env.GUZHI_STORAGE__MILVUS_TOKEN = "token-value";
    process.env.GUZHI_STORAGE__URL = "postgres://user:password-value@localhost/guzhi";
    const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-config-"));
    try {
      const loaded = await loadConfig({ cwd: root, repoRoot: root });
      const displayed = configForDisplay(loaded);
      expect(displayed.config).toMatchObject({
        storage: {
          milvus_password: "[REDACTED]",
          milvus_token: "[REDACTED]",
          url: "postgres://user:%5BREDACTED%5D@localhost/guzhi",
        },
      });
      expect(loaded.config.storage.milvus_password).toBe("password-value");
      expect(loaded.config.storage.milvus_token).toBe("token-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
