import express from "express";
import type { DatabaseClient } from "./db/client.js";
import type { MigrationResult } from "./db/migrate.js";
import { errorHandler } from "./http/errors.js";
import { registerRoutes } from "./routes/index.js";
import { promptLibraryImportPath } from "./routes/prompt-routes.js";
import { getUploadsPath } from "./services/attachment-service.js";
import { createServices, type CreateServicesOptions } from "./services/index.js";

export interface CreateAppOptions extends CreateServicesOptions {
  databaseClient: DatabaseClient;
  migrationResult: MigrationResult;
}

export function createApp({
  databaseClient,
  migrationResult,
  embeddingModel,
  taskIdSuffixGenerator,
}: CreateAppOptions) {
  const app = express();
  const services = createServices(databaseClient, {
    embeddingModel,
    taskIdSuffixGenerator,
  });
  // Seeds the Default prompt library from the shipped catalog when it is
  // empty, so the server and every route test start from the same library.
  services.prompts.ensureDefaultLibrary();

  // The prompt library import route mounts its own, larger JSON parser; the
  // app-wide one keeps the 100 KB default for every other route.
  const jsonBody = express.json();
  app.use((req, res, next) =>
    req.path === promptLibraryImportPath ? next() : jsonBody(req, res, next),
  );
  app.use("/uploads", express.static(getUploadsPath()));
  registerRoutes(app, { databaseClient, migrationResult, services });
  app.use(errorHandler);

  return app;
}
