import type { ErrorRequestHandler } from "express";
import type { JsonObject } from "../db/schema.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: JsonObject = {},
  ) {
    super(message);
  }
}

// body-parser rejects a body it cannot read with a 4xx `status` and a
// `type` such as "entity.too.large" or "entity.parse.failed". Those are
// client mistakes and must not surface as 500s.
function bodyParserFailure(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const { type, status } = error as { type?: unknown; status?: unknown };
  if (
    typeof type !== "string" ||
    typeof status !== "number" ||
    status < 400 ||
    status >= 500
  ) {
    return null;
  }
  const message =
    type === "entity.too.large"
      ? "Request body is too large"
      : type === "entity.parse.failed"
        ? "Request body is not valid JSON"
        : "Request body could not be read";
  return { status, message, type };
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  void next;

  const bodyFailure = bodyParserFailure(error);
  if (bodyFailure) {
    res.status(bodyFailure.status).json({
      error: {
        code: "invalid_request",
        message: bodyFailure.message,
        details: { type: bodyFailure.type },
      },
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Internal server error",
      details: {},
    },
  });
};
