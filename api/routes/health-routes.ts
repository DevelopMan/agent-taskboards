import type { Express } from "express";
import type { DatabaseClient } from "../db/client.js";
import type { MigrationResult } from "../db/migrate.js";
import {
  getDefaultEmbeddingModelPath,
  hasLocalEmbeddingModel,
} from "../embeddings/local.js";

export function registerHealthRoutes(
  app: Express,
  databaseClient: DatabaseClient,
  migrationResult: MigrationResult,
) {
  app.get("/api/health", (_req, res) => {
    const embedding = describeEmbeddingModel();

    try {
      databaseClient.sqlite.prepare("SELECT 1").get();
      res.json({
        ok: true,
        database: {
          ok: true,
          path: databaseClient.databasePath,
          migrations: migrationResult,
        },
        embedding,
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        database: {
          ok: false,
          error:
            error instanceof Error ? error.message : "Unknown database error",
        },
        embedding,
      });
    }
  });
}

/**
 * Reports which GGUF file semantic search will load and whether it exists.
 * The path is resolved on every request so a model dropped into the mounted
 * directory after startup is reported without a restart.
 */
export function describeEmbeddingModel() {
  const modelPath = getDefaultEmbeddingModelPath();
  return {
    modelPath,
    available: hasLocalEmbeddingModel(modelPath),
  };
}
