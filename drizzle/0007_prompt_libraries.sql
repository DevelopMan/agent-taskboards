-- Prompt libraries: prompts and categories gain an owning library.
--
-- Every row that exists when this migration runs moves into the "Custom"
-- library with its default_key cleared, and an empty "Default" library is
-- created next to it. PromptService.ensureDefaultLibrary() fills Default from
-- api/models/default-prompts.ts on startup, so the catalog is not repeated
-- here. This applies to fresh installs too: their 0006 seed lands in Custom.
--
-- SQLite cannot add a NOT NULL foreign-key column in place, so
-- prompt_categories and prompts are rebuilt (create _new, copy, drop, rename).
-- Row ids are preserved, so prompt_category_links stays valid untouched: its
-- REFERENCES clauses resolve by table name, and nothing references the _new
-- names, so the renames leave them alone. The migration runner keeps
-- foreign_keys off while this file runs; otherwise dropping the old tables
-- would cascade-delete every link.

CREATE TABLE `prompt_libraries` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `position` INTEGER NOT NULL,
  `default_key` TEXT,
  `metadata` TEXT NOT NULL DEFAULT '{}',
  `created_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
  `updated_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER))
);

CREATE UNIQUE INDEX `prompt_libraries_name_unique` ON `prompt_libraries` (`name`);
CREATE UNIQUE INDEX `prompt_libraries_default_key_unique` ON `prompt_libraries` (`default_key`);
CREATE INDEX `prompt_libraries_position_idx` ON `prompt_libraries` (`position`);

INSERT INTO `prompt_libraries` (`id`, `name`, `position`, `default_key`)
VALUES
  ('prompt-library-default', 'Default', 0, 'default'),
  ('prompt-library-custom', 'Custom', 1, NULL);

-- prompt_categories: add library_id, scope the name uniqueness and the
-- position index to the library.

CREATE TABLE `prompt_categories_new` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `library_id` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT,
  `position` INTEGER NOT NULL,
  `default_key` TEXT,
  `metadata` TEXT NOT NULL DEFAULT '{}',
  `created_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
  `updated_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
  FOREIGN KEY (`library_id`) REFERENCES `prompt_libraries` (`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

INSERT INTO `prompt_categories_new`
  (`id`, `library_id`, `name`, `description`, `position`, `default_key`, `metadata`, `created_at`, `updated_at`)
SELECT
  `id`, 'prompt-library-custom', `name`, `description`, `position`, NULL, `metadata`, `created_at`, `updated_at`
FROM `prompt_categories`;

DROP TABLE `prompt_categories`;
ALTER TABLE `prompt_categories_new` RENAME TO `prompt_categories`;

CREATE UNIQUE INDEX `prompt_categories_library_name_unique` ON `prompt_categories` (`library_id`, `name`);
CREATE UNIQUE INDEX `prompt_categories_default_key_unique` ON `prompt_categories` (`default_key`);
CREATE INDEX `prompt_categories_library_position_idx` ON `prompt_categories` (`library_id`, `position`);

-- prompts: add library_id and a per-library position index. The unique index
-- on default_key stays global; only the Default library carries default keys.

CREATE TABLE `prompts_new` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `library_id` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `note` TEXT,
  `position` INTEGER NOT NULL,
  `usage_count` INTEGER NOT NULL DEFAULT 0,
  `last_used_at` INTEGER,
  `default_key` TEXT,
  `metadata` TEXT NOT NULL DEFAULT '{}',
  `created_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
  `updated_at` INTEGER NOT NULL DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
  FOREIGN KEY (`library_id`) REFERENCES `prompt_libraries` (`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

INSERT INTO `prompts_new`
  (`id`, `library_id`, `name`, `body`, `note`, `position`, `usage_count`, `last_used_at`, `default_key`, `metadata`, `created_at`, `updated_at`)
SELECT
  `id`, 'prompt-library-custom', `name`, `body`, `note`, `position`, `usage_count`, `last_used_at`, NULL, `metadata`, `created_at`, `updated_at`
FROM `prompts`;

DROP TABLE `prompts`;
ALTER TABLE `prompts_new` RENAME TO `prompts`;

CREATE UNIQUE INDEX `prompts_default_key_unique` ON `prompts` (`default_key`);
CREATE INDEX `prompts_library_position_idx` ON `prompts` (`library_id`, `position`);
CREATE INDEX `prompts_last_used_idx` ON `prompts` (`last_used_at`);
