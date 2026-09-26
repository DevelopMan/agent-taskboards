# Changelog

Important changes to Agent Taskboards are documented in this file.

## Released

### 2026-09-27

- **Contributor, support, and security guidance**
  (`add-contributor-support-and-w2r4tw`): `CONTRIBUTING.md` documents the
  Docker-based development workflow, local CI via `scripts/ci.sh`, and
  pull-request expectations. `SECURITY.md` states the single-user, no-auth
  security model, explains why localhost is the safe default and LAN exposure
  is an explicit operator decision, and routes vulnerability reports through
  GitHub private vulnerability reporting. GitHub issue forms for bug reports,
  setup help, and agent-integration feedback collect platform and version
  diagnostics while explicitly excluding task content, credentials, and
  database files. The README links the new security and contributing guidance.

### 2026-09-26

- **Continuous integration** (`add-continuous-integration-for-tbsg8t`): A
  GitHub Actions workflow runs on pull requests and pushes to `main` for
  `linux/amd64` and `linux/arm64`. It builds the Docker image with cached
  layers, then runs typecheck, lint, the full test suite, and the production
  build inside the image, and validates the Compose configuration matrix. No
  dependencies are installed on the runner and the embedding model is not
  required. `scripts/ci.sh` runs the same checks locally, and the Dockerfile now
  installs dependencies with `npm ci` so images match `package-lock.json`.
- **Parameterized Docker release startup**
  (`parameterize-docker-release-startup-zeu90q`): The published port, bind
  address, data and uploads directories, and embedding model directory and file
  are now Compose variables with safe defaults, documented in `.env.example`.
  The published port binds to `127.0.0.1` unless LAN exposure is chosen
  explicitly, the model directory is mounted read-only at `/models`, and
  `GET /api/health` reports the resolved embedding model path and whether the
  file exists. `scripts/check-compose-config.sh` validates the default,
  custom-port, custom-storage, custom-model, and LAN configurations. The Docker
  build context now excludes runtime data, uploads, scratch files, SQLite
  files, and `.env`, so release images no longer embed the local database.

### 2026-09-24

- **Block drag-reorder for selected tasks** (`allow-drag-reorder-for-eb5o0y`):
  A selection of tasks within one board column can now be dragged onto another
  card in that column to reorder it as a block, taking the target card's slot.
  Non-contiguous selections gather into one block. Same-column drops, for
  single cards too, now only reorder under the `Position` sort instead of
  writing the visible index of another sort as the stored position.

### 2026-09-20

- **Prompt library tools** (`prompt-library-tools-n084qh`): Added a global
  library for organizing reusable prompts into categories, maintaining the
  built-in prompt catalog, and tracking recently used prompts. The task detail
  prompt picker can copy prompts with task, parent-task, board, and project
  tokens filled in. The feature also includes prompt and category management in
  the UI and REST API support.
