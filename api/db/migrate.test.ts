import { asc, eq } from "drizzle-orm";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  promptCategories,
  promptCategoryLinks,
  promptLibraries,
  prompts,
} from "./schema.js";

const REPO_MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");
const PROMPT_LIBRARIES_MIGRATION = "0007_prompt_libraries.sql";
const DEFAULT_LIBRARY_ID = "prompt-library-default";
const CUSTOM_LIBRARY_ID = "prompt-library-custom";

interface SchemaMigrationRow {
  id: string;
}

interface CountRow {
  count: number;
}

describe("runMigrations", () => {
  let tmpDir: string | undefined;
  let client: DatabaseClient | undefined;

  afterEach(() => {
    client?.close();
    client = undefined;

    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "taskboards-migrate-"));
    return {
      databasePath: join(tmpDir, "test.sqlite"),
      migrationsDir: join(tmpDir, "drizzle"),
    };
  }

  // Copies the repo's migration files that sort before `before` into a
  // throwaway directory so a database can be brought to a historical state.
  function copyMigrations(migrationsDir: string, before: string) {
    mkdirSync(migrationsDir, { recursive: true });
    const copied = readdirSync(REPO_MIGRATIONS_DIR)
      .filter((fileName) => fileName.endsWith(".sql") && fileName < before)
      .sort();
    for (const fileName of copied) {
      copyFileSync(
        join(REPO_MIGRATIONS_DIR, fileName),
        join(migrationsDir, fileName),
      );
    }
    return copied;
  }

  function appliedMigrationIds(databasePath: string) {
    const readClient = createDatabaseClient(databasePath);
    try {
      return readClient.sqlite
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all()
        .map((row) => (row as SchemaMigrationRow).id);
    } finally {
      readClient.close();
    }
  }

  it("moves every existing prompt and category into the Custom library", () => {
    const { databasePath, migrationsDir } = setup();
    const earlier = copyMigrations(migrationsDir, PROMPT_LIBRARIES_MIGRATION);
    expect(earlier.at(-1)).toBe("0006_prompt_library.sql");

    expect(runMigrations({ databasePath, migrationsDir }).applied).toEqual(
      earlier,
    );

    // The Drizzle schema already describes the post-0007 tables, so the
    // pre-migration rows are written with plain SQL against the 0006 layout.
    const seedClient = createDatabaseClient(databasePath);
    const seededPromptCount = (
      seedClient.sqlite
        .prepare("SELECT count(*) AS count FROM prompts")
        .get() as CountRow
    ).count;
    const seededCategoryCount = (
      seedClient.sqlite
        .prepare("SELECT count(*) AS count FROM prompt_categories")
        .get() as CountRow
    ).count;
    const seededLinkCount = (
      seedClient.sqlite
        .prepare("SELECT count(*) AS count FROM prompt_category_links")
        .get() as CountRow
    ).count;
    expect(seededPromptCount).toBeGreaterThan(0);
    expect(seededCategoryCount).toBeGreaterThan(0);
    expect(seededLinkCount).toBeGreaterThan(0);

    const lastUsedAt = Date.UTC(2026, 8, 1, 12, 0, 0);
    const createdAt = Date.UTC(2026, 7, 15, 9, 30, 0);
    seedClient.sqlite
      .prepare(
        `INSERT INTO prompt_categories
           (id, name, description, position, default_key, metadata, created_at, updated_at)
         VALUES
           ('category-bugfix', 'Bugfix', 'Prompts for bug fixing', ?, NULL, '{"color":"red"}', ?, ?)`,
      )
      .run(seededCategoryCount, createdAt, createdAt);
    seedClient.sqlite
      .prepare(
        `INSERT INTO prompts
           (id, name, body, note, position, usage_count, last_used_at, default_key, metadata, created_at, updated_at)
         VALUES
           ('prompt-fix-bug', 'Fix the bug', 'Fix {{TASK}} carefully.', 'Use for bugs', ?, 3, ?, NULL, '{"pinned":true}', ?, ?)`,
      )
      .run(seededPromptCount, lastUsedAt, createdAt, createdAt);
    seedClient.sqlite
      .prepare(
        `INSERT INTO prompt_category_links (id, prompt_id, category_id, position)
         VALUES
           ('link-fix-bug-bugfix', 'prompt-fix-bug', 'category-bugfix', 0),
           ('link-fix-bug-planning', 'prompt-fix-bug', 'prompt-category-planning', 1)`,
      )
      .run();
    seedClient.close();

    const result = runMigrations({
      databasePath,
      migrationsDir: REPO_MIGRATIONS_DIR,
    });
    expect(result.applied).toEqual([PROMPT_LIBRARIES_MIGRATION]);
    expect(result.skipped).toEqual(earlier);

    client = createDatabaseClient(databasePath);
    const { db, sqlite } = client;

    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);

    const tableNames = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'prompt%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tableNames).toEqual([
      "prompt_categories",
      "prompt_category_links",
      "prompt_libraries",
      "prompts",
    ]);

    const libraries = db
      .select()
      .from(promptLibraries)
      .orderBy(asc(promptLibraries.position))
      .all();
    expect(
      libraries.map(({ id, name, position, defaultKey, metadata }) => ({
        id,
        name,
        position,
        defaultKey,
        metadata,
      })),
    ).toEqual([
      {
        id: DEFAULT_LIBRARY_ID,
        name: "Default",
        position: 0,
        defaultKey: "default",
        metadata: {},
      },
      {
        id: CUSTOM_LIBRARY_ID,
        name: "Custom",
        position: 1,
        defaultKey: null,
        metadata: {},
      },
    ]);

    const categories = db.select().from(promptCategories).all();
    expect(categories).toHaveLength(seededCategoryCount + 1);
    expect(new Set(categories.map((category) => category.libraryId))).toEqual(
      new Set([CUSTOM_LIBRARY_ID]),
    );
    expect(categories.every((category) => category.defaultKey === null)).toBe(
      true,
    );

    const migratedCategory = categories.find(
      (category) => category.id === "category-bugfix",
    );
    expect(migratedCategory).toMatchObject({
      name: "Bugfix",
      description: "Prompts for bug fixing",
      position: seededCategoryCount,
      metadata: { color: "red" },
    });
    expect(migratedCategory?.createdAt.getTime()).toBe(createdAt);

    const migratedPrompts = db.select().from(prompts).all();
    expect(migratedPrompts).toHaveLength(seededPromptCount + 1);
    expect(new Set(migratedPrompts.map((prompt) => prompt.libraryId))).toEqual(
      new Set([CUSTOM_LIBRARY_ID]),
    );
    expect(migratedPrompts.every((prompt) => prompt.defaultKey === null)).toBe(
      true,
    );

    const migratedPrompt = migratedPrompts.find(
      (prompt) => prompt.id === "prompt-fix-bug",
    );
    expect(migratedPrompt).toMatchObject({
      name: "Fix the bug",
      body: "Fix {{TASK}} carefully.",
      note: "Use for bugs",
      position: seededPromptCount,
      usageCount: 3,
      metadata: { pinned: true },
    });
    expect(migratedPrompt?.lastUsedAt?.getTime()).toBe(lastUsedAt);
    expect(migratedPrompt?.createdAt.getTime()).toBe(createdAt);

    const seededPositions = migratedPrompts
      .filter((prompt) => prompt.id !== "prompt-fix-bug")
      .map((prompt) => prompt.position)
      .sort((a, b) => a - b);
    expect(seededPositions).toEqual(
      seededPositions.map((_, index) => index),
    );

    const links = db.select().from(promptCategoryLinks).all();
    expect(links).toHaveLength(seededLinkCount + 2);
    expect(
      links
        .filter((link) => link.promptId === "prompt-fix-bug")
        .sort((a, b) => a.position - b.position)
        .map((link) => [link.categoryId, link.position]),
    ).toEqual([
      ["category-bugfix", 0],
      ["prompt-category-planning", 1],
    ]);

    const linkForeignKeys = (
      sqlite.pragma("foreign_key_list(prompt_category_links)") as {
        table: string;
      }[]
    )
      .map((row) => row.table)
      .sort();
    expect(linkForeignKeys).toEqual(["prompt_categories", "prompts"]);

    expect(
      db
        .select()
        .from(prompts)
        .where(eq(prompts.libraryId, DEFAULT_LIBRARY_ID))
        .all(),
    ).toEqual([]);
    expect(
      db
        .select()
        .from(promptCategories)
        .where(eq(promptCategories.libraryId, DEFAULT_LIBRARY_ID))
        .all(),
    ).toEqual([]);

    // The rebuilt tables carry the cascade: deleting a library removes its
    // categories and prompts, and the untouched links table follows them.
    db.delete(promptLibraries)
      .where(eq(promptLibraries.id, CUSTOM_LIBRARY_ID))
      .run();
    expect(db.select().from(prompts).all()).toEqual([]);
    expect(db.select().from(promptCategories).all()).toEqual([]);
    expect(db.select().from(promptCategoryLinks).all()).toEqual([]);
  });

  it("applies 0007 to a fresh database and leaves Default empty", () => {
    const { databasePath } = setup();

    const result = runMigrations({
      databasePath,
      migrationsDir: REPO_MIGRATIONS_DIR,
    });
    expect(result.applied).toContain(PROMPT_LIBRARIES_MIGRATION);
    expect(result.skipped).toEqual([]);

    client = createDatabaseClient(databasePath);
    const { db } = client;

    expect(
      db
        .select({ id: promptLibraries.id })
        .from(promptLibraries)
        .orderBy(asc(promptLibraries.position))
        .all()
        .map((row) => row.id),
    ).toEqual([DEFAULT_LIBRARY_ID, CUSTOM_LIBRARY_ID]);

    const seeded = db.select().from(prompts).all();
    expect(seeded.length).toBeGreaterThan(0);
    expect(
      seeded.every(
        (prompt) =>
          prompt.libraryId === CUSTOM_LIBRARY_ID && prompt.defaultKey === null,
      ),
    ).toBe(true);
    expect(
      db
        .select()
        .from(prompts)
        .where(eq(prompts.libraryId, DEFAULT_LIBRARY_ID))
        .all(),
    ).toEqual([]);
  });

  it("rolls back a migration that leaves foreign key violations", () => {
    const { databasePath, migrationsDir } = setup();
    const good = copyMigrations(migrationsDir, "0008");
    const badMigration = "0008_dangling_prompt.sql";
    writeFileSync(
      join(migrationsDir, badMigration),
      `INSERT INTO prompts (id, library_id, name, body, position)
       VALUES ('prompt-orphan', 'prompt-library-missing', 'Orphan', 'body', 99);`,
    );

    expect(() => runMigrations({ databasePath, migrationsDir })).toThrow(
      /0008_dangling_prompt\.sql left 1 foreign key violation\(s\): prompts rowid \d+ -> prompt_libraries/,
    );

    expect(appliedMigrationIds(databasePath)).toEqual(good);

    client = createDatabaseClient(databasePath);
    expect(
      client.db.select().from(prompts).where(eq(prompts.id, "prompt-orphan")).all(),
    ).toEqual([]);
    expect(client.sqlite.pragma("foreign_key_check")).toEqual([]);
    client.close();
    client = undefined;

    rmSync(join(migrationsDir, badMigration));
    const rerun = runMigrations({ databasePath, migrationsDir });
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toEqual(good);
  });
});
