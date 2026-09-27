# Changelog

Important changes to Agent Taskboards are documented in this file.

## Released

### 2026-09-27

- **README rewrite for the v0.1.0 public preview**
  (`rewrite-the-readme-for-bv12lx`): The README now leads with the launch
  positioning (local Kanban and durable memory for coding agents), the
  one-command `scripts/start-local.sh` quick start, and the three
  differentiators, followed by the prompt library as a secondary
  differentiator with its current boundaries, Good fit / Not a fit, agent
  setup for Claude Code with a Codex section pending verification, supported
  platforms, privacy and LAN-security notes, troubleshooting, and a manual
  Docker Compose setup. The launcher's model menu now preselects F32, so the
  interactive path, the manual path, and the Compose default all resolve to
  `bge-small-en-v1.5-f32.gguf`.
- **Interactive first-run setup and release launcher**
  (`build-interactive-first-run-t95ve7`): `scripts/start-local.sh` checks
  Docker and Docker Compose, then interactively configures a new installation:
  embedding model (F32 by default, matching Compose; Q8, Q4, F16, or a
  validated existing GGUF file, with download sizes and tradeoffs shown), host port, data and uploads
  directories, and network binding. Curated models download to a temporary
  file, are verified against a pinned SHA-256 digest, and install atomically;
  interrupted or failed downloads clean up after themselves and print a
  recovery command. LAN binding requires an explicit acknowledgement that the
  API is unauthenticated. The script persists only its managed keys in the
  ignored `.env`, preserving other entries, reuses a valid configuration on
  later runs (`--reconfigure` to change it), and launches release mode with
  `docker compose up --build`.
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
