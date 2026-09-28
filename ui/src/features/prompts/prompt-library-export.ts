import type {
  PromptLibrary,
  PromptLibraryExport,
  PromptLibraryImportResult,
} from "../../domain/types";
import { ApiClientError } from "../../lib/api";

// Mirrors the server's slug so a missing Content-Disposition header still
// yields the same file name.
export function promptLibraryFileName(libraryName: string) {
  const slug = libraryName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "prompt-library"}.prompt-library.json`;
}

export type ParsedPromptLibraryFile =
  | { ok: true; document: PromptLibraryExport }
  | { ok: false; error: string };

// A light check that catches the wrong file before the request goes out:
// the server's schema is the authority on everything finer than this.
export function parsePromptLibraryFile(text: string): ParsedPromptLibraryFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "The file does not contain a prompt library export" };
  }
  if (value.format !== "taskboards-prompt-library") {
    return { ok: false, error: "The file is not a Taskboards prompt library export" };
  }
  if (value.version !== 1) {
    return { ok: false, error: `Unsupported prompt library export version ${String(value.version)}` };
  }
  if (!isRecord(value.library) || typeof value.library.name !== "string" || !value.library.name.trim()) {
    return { ok: false, error: "The export has no library name" };
  }
  if (!Array.isArray(value.categories) || !Array.isArray(value.prompts)) {
    return { ok: false, error: "The export is missing its categories or prompts list" };
  }
  // Only the export fields travel on. In particular a top-level `onConflict`
  // in the file must not skip the conflict dialog: the mode is the user's
  // choice, made in the dialog, never the file's.
  const document = {
    format: value.format,
    version: value.version,
    ...(typeof value.exportedAt === "string" ? { exportedAt: value.exportedAt } : {}),
    library: value.library,
    categories: value.categories,
    prompts: value.prompts,
  };
  return { ok: true, document: document as unknown as PromptLibraryExport };
}

// The client-side twin of the server's name lookup: trimmed exact match,
// with "Default" in any casing meaning the system library.
export function findLibraryByName(libraries: PromptLibrary[], name: string) {
  const trimmed = name.trim();
  if (trimmed.toLowerCase() === "default") {
    const defaultLibrary = libraries.find((library) => library.isDefault);
    if (defaultLibrary) {
      return defaultLibrary;
    }
  }
  return libraries.find((library) => library.name === trimmed) ?? null;
}

// One line naming the library and what happened to it. Zero counts are left
// out so an append that added nothing reads as such.
export function importSummary(result: PromptLibraryImportResult) {
  const verb =
    result.mode === "create" || result.mode === "copy" ? "Created" : "Imported into";
  const parts: string[] = [];
  const added = [
    count(result.created.categories, "category", "categories"),
    count(result.created.prompts, "prompt"),
  ].filter((part): part is string => part !== null);
  if (added.length > 0) {
    parts.push(`${added.join(" and ")} added`);
  }
  const replaced = [
    count(result.updated.categories, "category", "categories"),
    count(result.updated.prompts, "prompt"),
  ].filter((part): part is string => part !== null);
  if (replaced.length > 0) {
    parts.push(`${replaced.join(" and ")} replaced`);
  }
  if (result.skipped.prompts > 0) {
    parts.push(`${result.skipped.prompts} skipped`);
  }
  const detail = parts.length > 0 ? parts.join(", ") : "nothing to add";
  return `${verb} “${result.library.name}”: ${detail}`;
}

// Turns the import route's structured failures into one readable line. The
// `library_exists` conflict is not a message: the caller turns it into the
// conflict dialog instead.
export function importFailureMessage(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || !isRecord(error.details)) {
    return null;
  }
  const { details } = error;
  if (error.status === 409 && details.conflict === "ambiguous_prompt_names") {
    const inFile = stringList(details.inFile);
    const inLibrary = stringList(details.inLibrary);
    const where = [
      inFile.length > 0 ? `in the file: ${inFile.join(", ")}` : null,
      inLibrary.length > 0 ? `in the library: ${inLibrary.join(", ")}` : null,
    ].filter((part): part is string => part !== null);
    return `Append and replace need unique prompt names. Duplicated ${where.join("; ")}. Rename them or import as a copy.`;
  }
  if (error.status === 400 && Array.isArray(details.issues)) {
    const issue = details.issues.find(isRecord);
    const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
    const reason = typeof issue?.message === "string" ? issue.message : error.message;
    return path ? `${reason} (at ${path})` : reason;
  }
  return null;
}

export function isLibraryExistsConflict(error: unknown): { name: string } | null {
  if (
    error instanceof ApiClientError &&
    error.status === 409 &&
    isRecord(error.details) &&
    error.details.conflict === "library_exists" &&
    typeof error.details.name === "string"
  ) {
    return { name: error.details.name };
  }
  return null;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function count(value: number, singular: string, plural = `${singular}s`) {
  if (value === 0) {
    return null;
  }
  return `${value} ${value === 1 ? singular : plural}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
