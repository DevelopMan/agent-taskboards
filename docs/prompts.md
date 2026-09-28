# Prompt Library

The prompt library stores reusable prompt texts that humans copy into coding
agent sessions. It is managed in the UI under the sidebar `Prompts` entry and
surfaced next to the task detail through the prompt picker.

## Data Model

Prompts and categories are global: they live outside the project/board
hierarchy, and one library is shared across all projects.

- `prompt_categories`: flat list of categories (no nesting). Names are unique
  and may contain emoji. Categories carry a `position` for ordering and an
  optional `default_key` marking seeded defaults.
- `prompts`: prompt `name` (emoji allowed), `body`, an optional author `note`,
  `position`, usage counters (`usage_count`, `last_used_at`), and an optional
  `default_key`.
- `prompt_category_links`: many-to-many links between prompts and categories.
  A prompt with no links is "root level" (uncategorized).

Deletion is hard deletion behind a confirmation dialog; prompts are not
archivable. Deleting a category removes only the category and its links —
prompts survive and fall back to the root level.

Prompts are not indexed into `search_documents`, so they do not appear in
semantic search.

## Author Notes

A prompt may carry a short `note`: help text from whoever wrote the prompt,
most useful on default prompts an end user did not author. It is plain text
with no length cap, shown verbatim — no markdown, and no token substitution.

The note is commentary about the prompt, not part of it: copying a prompt
never puts the note on the clipboard, and neither the picker filter nor
`GET /api/prompts?q=` matches it. System defaults may include notes that
explain when and how to use them.

In the library editor the note sits between Name and Body and reads as static
text, turning into a textarea on click and collapsing back on blur or Escape.
It saves with the rest of the form through Save or Cmd/Ctrl+Enter, and Cancel
discards it along with the other edits. A prompt without a note shows a muted `Add a note`
placeholder in the same spot.

## Ordering

Prompts carry a single global order in `prompts.position`. A category view is
only a projection of that order, so a prompt linked to two categories keeps
the same relative order in both, and dragging it inside one category rewrites
the one list. Categories have their own order in `prompt_categories.position`,
which drives the library's left rail and the picker's groups.

`prompt_category_links.position` is unrelated to either: it orders the
categories *within* a prompt, and reordering never touches it.

Both orders are edited through the reorder endpoints in `docs/api.md`, which
rewrite the affected list as `0..n-1`. The picker's `Recent` group is sorted by
`lastUsedAt` rather than by position, so it is never reorderable, and a
reorder never counts as a use.

## Tokens

Prompt bodies may contain case-sensitive tokens that the prompt picker
replaces when copying:

- `{{TASK}}`: the open task, formatted as `"...title..." ( id=... )`
- `{{PARENT_TASK}}`: the task's parent/umbrella task in the same format
- `{{BOARD}}`: the board the open task belongs to, as `"...name..." ( id=... )`
- `{{PROJECT}}`: that board's project, in the same format

A token that cannot be resolved never blocks the copy and produces no
warning: the braces are stripped, so `{{PARENT_TASK}}` copies as
`PARENT_TASK` and is easy to spot and replace by hand. Unknown `{{...}}`
sequences are left untouched.

`{{BOARD}}` and `{{PROJECT}}` need no resolution step: the picker only opens
over an open task, so its board and project are already loaded alongside it.
Both carry only a URL-safe `name` rather than a display title, so
`{{PROJECT}}` renders as `"agent-taskboards" ( id=... )`.

The seeded default prompts use `{{TASK}}`, `{{PARENT_TASK}}`, and `{{BOARD}}`.
Some also carry an `{{EPIC_TASK}}` placeholder, which is intentionally not a
picker token and remains in the copied text for the user to fill in.

### Parent Task Resolution

`{{PARENT_TASK}}` resolves through a heuristic cascade with no task schema
change:

1. A parent id in the task's metadata: `parentTaskId` first, then the older
   `parentTask`, `umbrellaTaskId`, and `umbrella` keys. The value must be a
   bare task id; a title or flag falls through to the next step.
2. The first description line that starts with a parent label:
   `Umbrella task:`, `Umbrella:`, `Parent task:`, or `Parent:`. Labels are
   case-insensitive and may be preceded by markdown list, quote, or bold
   decoration, but not by prose — `part of the umbrella: x` does not match.
   An `id=...` reference on the label line wins; otherwise the candidate is
   the first token after the label, stripped of surrounding backticks,
   quotes, and brackets and of trailing `.,;:`, and capped at 96 characters.
   How strictly that token is judged depends on what follows it: when it is
   the whole value, any `[A-Za-z0-9_-]+` id is accepted, so hand-written and
   legacy ids still resolve; when prose follows it on the same line, the
   token must be quoted or match the generated id shape (slug words joined
   by `-` plus a six-character lowercase suffix). That keeps
   ``Umbrella: `some-task-a1b2c3`. Collector for the follow-ups...`` working
   while `Parent: the big epic` falls through to the next step.
3. The first description line that mentions "umbrella" (case-insensitive) and
   contains an `id=...` reference.
4. The first `id=...` reference anywhere in the description.
5. Otherwise unresolved.

Self references are skipped. If the parent id resolves but the task cannot be
fetched, the token renders as `( id=<id> )` so the pasted prompt is still
actionable.

## Default Prompts

The `0006_prompt_library.sql` migration seeds three default categories and 14
prompts, all keyed by stable `default_key` values:

- `Planning`
  - `expand-task` — ↔️ Expand Task
  - `create-scoped-tasks` — 📝 Create scoped tasks
- `Implementing`
  - `task-implementation` — ▶️ Task Implementation
  - `umbrella-implement` — ☂️▶️ Umbrella Task Implement
  - `epic-umbrella-implement` — ☂️🦸 Epic+Umbrella Task Implement
  - `code-review` — 👮‍♂️ Code Review
  - `umbrella-code-review` — ☂️👮‍♂️ Umbrella Task Code Review
  - `epic-umbrella-code-review` — ☂️🦸👮‍♂️ Epic+Umbrella Task Code Review
  - `post-review-compaction` — 💼 Post-review compaction
  - `address-review-findings` — 🚑 Fix Review Findings
  - `task-follow-up` — ⏯️ Task Follow-up
  - `taskboard-loop` — ♻️ Taskboard Loop Prompt
- `Misc`
  - `merge-conflicts-resolve` — 🔀🛠️ Merge Conflicts Resolve
  - `virtual-rebase-merge-conflicts-assistance` — 🔀🛠️ Virtual Rebase Merge
    Conflicts Assistance

The seed values mirror `api/models/default-prompts.ts`, which also backs the
`Restore defaults` action (`POST /api/prompts/restore-defaults`). Restore
reconciles system-owned names, bodies, notes, order, categories, and links to
this exact catalog, removes obsolete system defaults, and remains idempotent.
User-created prompts and categories are preserved and ordered after system
defaults. A same-named user row is adopted when its default key is missing,
which upgrades databases created before that key was introduced without
creating a duplicate.

## Import and Export

A library can be downloaded as one JSON file and a file can be imported back,
on this machine or another. One file holds exactly one library. Export is
available from the `Export` button in the Prompt Manager topbar (the selected
library) and from the download icon on every library pill, Default included;
`Import` opens a file picker next to it.

### File format

```json
{
  "format": "taskboards-prompt-library",
  "version": 1,
  "exportedAt": "2026-09-28T12:00:00.000Z",
  "library": { "name": "Team", "metadata": {} },
  "categories": [
    { "name": "Planning", "description": null, "metadata": {} }
  ],
  "prompts": [
    {
      "name": "Plan a task",
      "body": "...",
      "note": null,
      "metadata": {},
      "categories": ["Planning"]
    }
  ]
}
```

Only content and metadata are exported: library `name` and `metadata`;
category `name`, `description`, and `metadata`; prompt `name`, `body`,
`note`, `metadata`, and the names of its categories. Array order is position
order and `prompt.categories` order is the link order, so there is no
`position` field. Ids, timestamps, `defaultKey`, `usageCount`, and
`lastUsedAt` are not written, and every row an import creates is a plain user
row with counters at zero and no default key. `exportedAt` is informational.
The download is named `<library-name-slug>.prompt-library.json`.

### Import rules

The whole file is validated first and then written in one transaction, so a
bad file or a conflict changes nothing. The file's library name (trimmed;
"Default" in any casing means the Default library) decides what happens:

- No library has that name: a new library is created at the end of the pills
  row with the file's categories, prompts, and links in file order.
- The name is taken: the Prompt Manager asks how to proceed.
  - **Append** adds the categories and prompts whose names are missing from
    the target and skips the rest, so importing the same file twice is a
    no-op.
  - **Append and replace** does the same for missing rows and overwrites
    matched prompts in place: `body`, `note`, `metadata`, and the category
    links come from the file, while `position`, `usageCount`, `lastUsedAt`,
    and `defaultKey` stay. Matched categories get the file's `description`
    and `metadata`.
  - **Import as copy** creates a separate library named `<name> (2)`, or the
    smallest free number from 2 upward. An existing trailing number is never
    parsed: importing "Team (2)" over an existing "Team (2)" gives
    "Team (2) (2)".

Categories are matched by exact name inside the target library; missing ones
are created at the end in file order. Neither append nor replace ever deletes
or reorders rows the file does not mention, and the target library's own
`metadata` is left alone.

Append and replace identify prompts by name, so they refuse a file or a target
library in which two prompts share a name. The dialog names the duplicates;
rename them or import as a copy, which has no such rule. Duplicate category
names inside a file are always rejected.

All three modes may target Default. Append adds user rows to it, which manual
creation already allows. Replace edits matched default prompts and categories
in place and keeps their default keys, so `Restore defaults` still reverts
their bodies, notes, descriptions, and category links. It does not touch
`metadata`, so metadata written by a replace stays, exactly as metadata set
through the API does. A file exported from Default and imported as a copy
becomes "Default (2)" without default keys.

A file that is not valid JSON or not a prompt library export is refused in
the browser before any request. Everything finer (blank names, empty bodies,
unknown category names on a prompt) is refused by the API with the failing
path. The file name and its library name are not related: users rename the
library through its pill afterwards.

## Prompt Picker

The prompt picker opens from a toggle in the task detail header and extends
as a nested sidebar on the task detail's left. It is visible by default, and
closing or reopening it saves that preference in the browser. It shows:

- a read-only row of library pills, only when more than one library exists
- a filter input over prompt names and bodies
- a `Recent` group with up to three of the selected library's most recently
  used prompts for one-click copying
- the selected library's prompts grouped by category, with root-level prompts
  last

The picker shows one library at a time. Its selection is remembered in the
browser under `taskboards.task.promptPickerLibraryId`, independently of the
Prompt Manager's, and falls back to Default when the stored library no longer
exists. Filtering, `Recent`, the groups, and drag reorder all stay inside the
selected library, so a prompt used in another library never appears in
`Recent` here and a drag never rewrites another library's order. Switching
pills keeps the filter text and resets the expanded preview and copy
confirmation. An empty library reads "No prompts in this library yet."

Clicking a prompt row copies the rendered body (tokens replaced) to the
clipboard, records usage through `POST /api/prompts/:promptId/use`, and blinks
a confirmation. A row can be expanded to preview the exact rendered text
before copying. An expanded row shows the prompt's author note, if any, after
the preview and outside its box, so it reads as commentary rather than prompt
text.

One prompt can be rendered as several rows at once: in `Recent` and again in
each category it is linked to. Row state is keyed per row, so expanding a
preview or blinking the copy confirmation affects only the row that was
clicked, not its twins elsewhere in the picker.

## API

See the Prompt Library section in `docs/api.md` for the REST endpoints. The
markdown-first agent API (`/api/agents/prompts`) is deferred to a follow-up
task.
