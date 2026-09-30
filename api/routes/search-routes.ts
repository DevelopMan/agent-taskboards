import type { Express } from "express";
import { asyncHandler } from "../http/async-handler.js";
import { parseBody, parseQuery } from "../http/validation.js";
import {
  labelListQuerySchema,
  searchSchema,
} from "../models/request-schemas.js";
import type { ApiServices } from "../services/index.js";

export function registerSearchRoutes(app: Express, services: ApiServices) {
  app.post(
    "/api/search",
    asyncHandler(async (req, res) => {
      const body = parseBody(req, searchSchema);
      const results = await services.search.search(body);

      res.json({
        query: body.query,
        results,
      });
    }),
  );

  app.get("/api/labels", (req, res) => {
    const query = parseQuery(req, labelListQuerySchema);
    res.json({ labels: services.search.listLabels(query) });
  });
}
