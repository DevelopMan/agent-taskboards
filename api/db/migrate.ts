import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabaseClient, getDatabasePath } from "./client.js";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface RunMigrationsOptions {
  databasePath?: string;
  migrationsDir?: string;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

export function runMigrations({
  databasePath = getDatabasePath(),
  migrationsDir = resolve(process.cwd(), "drizzle"),
}: RunMigrationsOptions = {}): MigrationResult {
  const client = createDatabaseClient(databasePath);
  const applied: string[] = [];
  const skipped: string[] = [];

  // createDatabaseClient enables foreign_keys, and the pragma is a no-op
  // inside a transaction, so it has to change here, outside the per-file
  // transactions. Table rebuilds (create _new, copy, drop, rename) would
  // otherwise cascade-delete child rows when the old table is dropped. Each
  // applied file is verified with PRAGMA foreign_key_check instead.
  client.sqlite.pragma("foreign_keys = OFF");

  try {
    // drizzle-kit owns drizzle/meta for schema generation history. At runtime we
    // apply the generated *.sql files directly and track checksums here so the
    // app does not depend on drizzle-kit metadata in production containers.
    client.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER))
      );
    `);

    if (!existsSync(migrationsDir)) {
      return { applied, skipped };
    }

    const appliedMigrations = new Map(
      client.sqlite
        .prepare("SELECT id, checksum FROM schema_migrations")
        .all()
        .map((migration) => {
          const appliedMigration = migration as AppliedMigration;
          return [appliedMigration.id, appliedMigration.checksum] as const;
        }),
    );

    const migrationFiles = readdirSync(migrationsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    for (const fileName of migrationFiles) {
      const migrationPath = resolve(migrationsDir, fileName);
      const sql = readFileSync(migrationPath, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existingChecksum = appliedMigrations.get(fileName);

      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(
            `Applied migration ${fileName} has checksum ${existingChecksum}, expected ${checksum}`,
          );
        }

        skipped.push(fileName);
        continue;
      }

      const applyMigration = client.sqlite.transaction(() => {
        client.sqlite.exec(sql);
        assertForeignKeysConsistent(client.sqlite, fileName);
        client.sqlite
          .prepare(
            "INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)",
          )
          .run(fileName, checksum);
      });

      applyMigration();
      applied.push(fileName);
    }

    return { applied, skipped };
  } finally {
    client.sqlite.pragma("foreign_keys = ON");
    client.close();
  }
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

// Runs inside the migration's transaction, so a violation rolls the file back
// and leaves schema_migrations without it.
function assertForeignKeysConsistent(
  sqlite: Database.Database,
  fileName: string,
) {
  const violations = sqlite.pragma("foreign_key_check") as ForeignKeyViolation[];

  if (violations.length === 0) {
    return;
  }

  const summary = violations
    .slice(0, 10)
    .map(
      (violation) =>
        `${violation.table} rowid ${violation.rowid ?? "?"} -> ${violation.parent}`,
    )
    .join("; ");
  const suffix =
    violations.length > 10 ? `; and ${violations.length - 10} more` : "";

  throw new Error(
    `Migration ${fileName} left ${violations.length} foreign key violation(s): ${summary}${suffix}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runMigrations();
  console.log(
    JSON.stringify(
      {
        databasePath: getDatabasePath(),
        ...result,
      },
      null,
      2,
    ),
  );
}
