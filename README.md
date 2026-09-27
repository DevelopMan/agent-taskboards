# Agent Taskboards

**Local Kanban and durable memory for coding agents.**

Agent Taskboards runs on your machine and gives AI coding agents such as Claude
Code and Codex a task board they can actually use: a deterministic API for
creating, moving, and annotating work, append-only handoff history that
survives chat sessions, and semantic search over everything the board
remembers. You get the same board as a React UI.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENCE.md)
[![Status: public preview](https://img.shields.io/badge/status-v0.1.0%20public%20preview-orange.svg)](CHANGELOG.md)

<!--
Above-the-fold media: the workflow animation produced by the launch-assets task
(produce-launch-demo-and-lzwpeo) lands at docs/media/readme-demo.gif and
replaces the screenshot below. Keep the alt text.
-->
![Agent Taskboards board with an agent-driven task](screenshot.jpg)

## Quick Start

You need Docker with Docker Compose v2 and about 2 GB of free disk for the
image and the embedding model.

```sh
git clone https://github.com/WarehouseRobotics/agent-taskboards.git
cd agent-taskboards
scripts/start-local.sh
```

The launcher checks Docker, walks you through the embedding model download,
port, storage directories, and network binding, then builds and starts the app
in release mode. Every prompt has a safe default, so pressing Enter at each one
gives you a localhost-only install on port `8142` with the full-precision F32
model. When the log settles, open:

```text
http://localhost:8142
```

Press `Ctrl+C` to stop. Later runs reuse your configuration and skip straight to
launch; pass `-d` to run in the background or `--reconfigure` to change the
answers:

```sh
scripts/start-local.sh -d
scripts/start-local.sh --reconfigure
```

Prefer to run Docker Compose yourself, or work on the code? See
[Manual Setup](#manual-setup).

## Why Agent Taskboards

- **A deterministic API built for agents.** Agents create, move, search, and
  comment on tasks through JSON or markdown-first endpoints and a bundled shell
  wrapper. Stable IDs, explicit column transitions, and structured errors
  replace brittle UI automation.
- **Durable handoff history.** Comments are append-only and every state change
  is recorded as activity. An agent picking up a task sees what the previous
  session decided, what blocked it, and what still needs doing, long after the
  chat that produced it is gone.
- **Fully local semantic search.** Boards, tasks, and comments are embedded
  with a local GGUF model through `node-llama-cpp` and indexed in SQLite with
  `sqlite-vec`. Agents retrieve relevant prior work without sending your task
  data to a hosted service.

Everything stays on your machine: SQLite database, uploads, model weights. No
accounts, no telemetry, no hosted component. MIT licensed.

## Prompt Library

The prompt library turns a task into a ready-to-paste agent prompt. Open a
task, pick a prompt from the picker in the task detail, and the copied text has
the `{{TASK}}`, `{{PARENT_TASK}}`, `{{BOARD}}`, and `{{PROJECT}}` tokens
rendered as `"title" ( id=... )` references. Paste it into your agent session
and the agent has the exact task, its umbrella task, and the board and project
names to orient itself with.

The library ships with a starter set of planning, implementation, review, and
follow-up prompts organized in categories. You can edit them, add your own,
and restore the defaults at any time. Prompt and category names accept
emoji.

Current boundaries, so you know what you are getting:

- One global library shared by all projects; no per-project prompts.
- Clipboard-mediated: a human copies the rendered prompt into the agent. Agents
  do not browse or fetch prompts on their own.
- Prompts are not indexed for semantic search.
- Management is through the UI and the regular REST API. There is no
  `/api/agents/prompts` endpoint in v0.1.0.

See [docs/prompts.md](docs/prompts.md) for the data model, token resolution
rules, and the default prompt catalog.

## Good Fit / Not a Fit

**Good fit**

- One developer running coding agents against one or more repositories, who
  wants task state that outlives individual agent sessions.
- Handoffs between agents, or between you and an agent, that need a durable
  record of decisions and blockers.
- Private projects where task descriptions and comments must never leave the
  machine, but agents still need searchable project memory.
- Coordinating work across several local projects and workstreams from one
  board.

**Not a fit**

- Teams. The app is single-user: no accounts, permissions, or authentication.
- Anything internet-facing or production-grade. It is a local development tool.
- A replacement for a hosted issue tracker with integrations such as GitHub
  Issues or Jira sync.
- Fully autonomous prompt workflows. Prompts are copied by a human, and agents
  interact only with tasks, boards, and comments.

## Set Up Your Agents

Claude Code and Codex are the two integrations named for v0.1.0. Other agents
work through the same shell wrapper and HTTP API.

### Claude Code

The repo ships a Claude Code skill at `skills/tasks-management/` that teaches
the agent to drive the API through the bundled `taskboards` wrapper. Symlink it
into one of Claude Code's skill search paths.

User-global, available in every project:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/tasks-management" ~/.claude/skills/tasks-management
```

Project-local, available only inside one repo:

```sh
mkdir -p /path/to/your/project/.claude/skills
ln -s "$PWD/skills/tasks-management" \
  /path/to/your/project/.claude/skills/tasks-management
```

Optional environment variables for the wrapper. The defaults match the local
Docker setup:

- `TASKBOARDS_HOST_URL`: base URL, default `http://localhost:8142`.
- `TASKBOARDS_API_KEY`: bearer token, only sent when set. The server itself
  does not check it; it exists for authenticating proxies.
- `TASKBOARDS_AGENT_NAME`: comment author name, default `Claude Code`.
- `TASKBOARDS_AGENT_REF`: comment author reference; falls back to
  `$CLAUDE_SESSION_ID` or `local`.

Verify the install by starting a fresh Claude Code session in a project where
the skill is installed and asking it to run `taskboards health`. The agent
should pick the skill up automatically and report a healthy status.

Once you trust the skill, add a permission rule to `.claude/settings.json`
(shared with the project) or `.claude/settings.local.json` (personal,
gitignored) so Claude Code stops prompting on every wrapper call:

```json
{
  "permissions": {
    "allow": [
      "Bash(*/skills/tasks-management/scripts/taskboards *)",
      "Bash(*/skills/tasks-management/scripts/taskboards)"
    ]
  }
}
```

The wildcard prefix matches the wrapper regardless of install location
(`~/.claude/skills/...`, `<project>/.claude/skills/...`, or the literal
`${CLAUDE_SKILL_DIR}/...` form the agent may type). The second entry covers the
bare `taskboards` invocation with no arguments. Permission patterns match the
literal command string the agent sends to the Bash tool, so list every form you
want to allow.

### Tell your agent about the board

Create a project and a board in the UI, then add a section like this to your
project's `AGENTS.md` or `CLAUDE.md` so agents check the board before and
after doing work:

```markdown
## Project Task Management

Use the task-management skill for tracking project tasks. When performing tasks, you should check taskboard context and track tasks' states using the taskboards skill. This project data:

- taskboards project: `my-project-name` _(create if not found)_
- main board: `main` _(create if not found)_

Keep up with the task boards: **check and update taskboard tasks often!**
```

### Codex

<!--
TODO(fill-the-readme-codex-fs7p52): replace this paragraph with the verified
Codex install steps once document-and-verify-claude-rr9415 records them.
-->
Codex is the second named integration. Its step-by-step setup is still being
verified and will land here before the release. Until then, point Codex at the
wrapper and skill instructions as described under
[Other agents](#other-agents).

### Other agents

Any agent that can run shell commands or make HTTP requests can use the board:

- Give it `skills/tasks-management/SKILL.md`, which documents the wrapper
  grammar, shortcuts, and safe patterns for long text bodies, and let it call
  `skills/tasks-management/scripts/taskboards` directly.
- Or call the markdown-first agent API under `/api/agents/` or the JSON API
  under `/api/` yourself. See [API Orientation](#api-orientation).

Set `TASKBOARDS_AGENT_NAME` so comments and activity show which agent wrote
them.

A typical agent session looks like this:

```sh
skills/tasks-management/scripts/taskboards health
skills/tasks-management/scripts/taskboards get projects repositoryPath="$PWD"
skills/tasks-management/scripts/taskboards get projects/<projectId>/boards
skills/tasks-management/scripts/taskboards context <taskId>
skills/tasks-management/scripts/taskboards move <taskId> in_progress
skills/tasks-management/scripts/taskboards comment <taskId> --body-file /tmp/taskboards-note.md
skills/tasks-management/scripts/taskboards get search q="sqlite migration blocker" limit=10
```

Agents should search before creating tasks so they update existing work instead
of duplicating it, and should use `--body-file FILE`, `--field-file
description=FILE`, or `--data FILE` for any text containing quotes, backticks,
braces, or newlines.

## Configuration

`scripts/start-local.sh` writes its answers to an ignored `.env` file in the
repository root. Docker Compose reads the same variables from the shell or
from `.env`, and every setting has a safe default, so `.env` is optional:

```sh
cp .env.example .env
```

| Variable                  | Default                      | Purpose                                             |
| ------------------------- | ---------------------------- | --------------------------------------------------- |
| `TASKBOARDS_PORT`         | `8142`                       | Published host port for the UI and API              |
| `TASKBOARDS_BIND_ADDRESS` | `127.0.0.1`                  | Interface the port binds to; `0.0.0.0` exposes LAN  |
| `TASKBOARDS_DATA_DIR`     | `./data`                     | Host directory mounted at `/data` (SQLite database) |
| `TASKBOARDS_UPLOADS_DIR`  | `./uploads`                  | Host directory mounted at `/uploads`                |
| `TASKBOARDS_MODEL_DIR`    | `./models-gguf`              | Host directory mounted read-only at `/models`       |
| `TASKBOARDS_MODEL_FILE`   | `bge-small-en-v1.5-f32.gguf` | Model file name inside `TASKBOARDS_MODEL_DIR`       |
| `TASKBOARDS_DEBUG`        | `1`                          | `1` for watch mode, empty for release mode          |

Relative paths resolve from the repository root. Paths with spaces work.
Container-side paths and the internal port `8142` never change, so the API
always sees `/data/taskboards.sqlite`, `/uploads`, and
`/models/<TASKBOARDS_MODEL_FILE>`.

The launcher manages every variable except `TASKBOARDS_DEBUG` and preserves any
other entries you add to `.env`. The helper scripts and the launcher set
`TASKBOARDS_DEBUG` themselves, so the `.env` value only matters when you run
`docker compose` directly.

Runtime data lives in bind-mounted directories under the repository root
(or wherever the variables above point):

- `data/`: the SQLite database, `data/taskboards.sqlite`.
- `uploads/`: uploaded or imported files.
- `models-gguf/`: GGUF embedding models, mounted read-only.
- `tmp/`: scratch space; nothing here is durable.

All four are ignored by git except for their `.keep` placeholders. To back up
an installation, stop the app and copy `data/` and `uploads/`.

## Privacy and Network Security

- All data stays local: task content, comments, uploads, embeddings, and the
  model itself. Nothing phones home and there is no telemetry.
- The API and UI have **no authentication, no API keys, and no rate
  limiting**. The default `127.0.0.1` binding makes that safe: only processes
  on your machine can reach the app.
- **LAN exposure is unauthenticated.** With `TASKBOARDS_BIND_ADDRESS=0.0.0.0`,
  anyone who can reach your machine on the network can read and change every
  board. The launcher requires you to type `yes` after a warning before it
  writes that setting. Keep the default unless you trust the whole network, and
  prefer an SSH tunnel or an authenticating reverse proxy for remote access.
- The Docker build context excludes `data/`, `uploads/`, `tmp/`, SQLite files,
  and `.env`, so images never embed your database.

[SECURITY.md](SECURITY.md) describes the full security model and how to report
a vulnerability privately.

## Supported Platforms

Agent Taskboards runs wherever Docker with Compose v2 runs. For v0.1.0:

| Platform                        | Status                                              |
| ------------------------------- | --------------------------------------------------- |
| macOS on Apple Silicon          | Supported; release validation target                |
| Linux x86-64                    | Supported; release validation target                |
| Windows                         | Not tested for v0.1.0. Docker Desktop with WSL 2 is the most likely path; run the launcher from a WSL shell |

Continuous integration runs the checks on `linux/amd64` and `linux/arm64`.

## Troubleshooting

Every launcher failure prints an `error:` line and a `Recovery:` command. The
cases below cover what the launcher cannot detect for you.

- **Docker is not running or not installed.** The launcher stops before
  touching anything. Start Docker Desktop or the Docker daemon and rerun
  `scripts/start-local.sh`.
- **Port `8142` is already in use.** Run `scripts/start-local.sh --reconfigure`
  and choose another port, or set `TASKBOARDS_PORT` in `.env`.
- **Semantic search says the model file was not found.** The app starts
  without the model; only search and indexing need it. Check the resolved path
  and availability:

  ```sh
  curl -s http://localhost:8142/api/health
  ```

  The `embedding.modelPath` field shows the container path and
  `embedding.available` whether the file exists. Make sure the file named by
  `TASKBOARDS_MODEL_FILE` is inside `TASKBOARDS_MODEL_DIR`, or rerun the
  launcher with `--reconfigure` to download it again.
- **The model download failed or a digest mismatch was reported.** Downloads
  are verified against a pinned SHA-256 digest and never overwrite a working
  file. Rerun the launcher to retry; when an existing file fails verification,
  the launcher offers to re-download it.
- **The first start is slow.** The first `docker compose up --build` downloads
  the base image and installs dependencies, including native modules for
  `node-llama-cpp`. Later starts reuse the image.
- **Changes to `.env` do not seem to apply.** Restart with
  `docker compose down` followed by your usual start command. Note that the
  launcher and helper scripts override `TASKBOARDS_DEBUG`.
- **The LAN option was declined.** The launcher only writes `0.0.0.0` after a
  literal `yes`. Any other answer keeps the localhost binding.
- **Starting over.** Stop the app, then `scripts/start-local.sh --reconfigure`
  rewrites only the launcher-managed keys in `.env`. Your data in `data/` and
  `uploads/` is untouched unless you delete those directories yourself.

Still stuck? Open a
[setup help issue](https://github.com/WarehouseRobotics/agent-taskboards/issues/new?template=setup-help.yml)
with your platform and the launcher output. Redact anything private first.

## Manual Setup

The launcher is a convenience over plain Docker Compose. You can do each step
yourself.

### Embedding model

Semantic search needs a GGUF embedding model. The default, expected by Compose
and by the launcher, is the full-precision F32 build of `bge-small-en-v1.5`:

```text
models-gguf/bge-small-en-v1.5-f32.gguf
```

Download it from Hugging Face:

```sh
mkdir -p models-gguf
curl -L \
  -o models-gguf/bge-small-en-v1.5-f32.gguf \
  https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-f32.gguf
```

To use a smaller quantized build (`q8_0`, `q4_k_m`, `f16`) or any other GGUF
embedding model, download it to `models-gguf/` and set `TASKBOARDS_MODEL_FILE`
in `.env` to its file name; point `TASKBOARDS_MODEL_DIR` elsewhere if the file
lives outside the repo. The app starts without a model, but semantic search
stays unavailable until the file exists.

### Release mode

Release mode builds the API and UI into `dist/` and serves both from one
Express server on port `8142`:

```sh
TASKBOARDS_DEBUG= docker compose up --build
```

`scripts/run-release.sh` does the same and accepts `docker compose up`
arguments such as `--build` or `-d`.

### Debug mode

`docker-compose.yml` defaults to `TASKBOARDS_DEBUG=1`, which runs the Vite UI
on port `8142` and the Express API on port `3000` inside the container, with
Vite proxying `/api` to the API. Source changes reload without a rebuild:

```sh
docker compose up --build
```

Helper scripts wrap the common cases and run from any directory:

- `scripts/run.sh`: debug mode with the existing image.
- `scripts/run-build.sh`: rebuild the image, then debug mode.
- `scripts/run-release.sh`: release mode; add `--build` to rebuild.

## Development

Project scripts run inside Docker. Do not run `npm install` on the host.

Run checks in the running container:

```sh
docker compose exec taskboards npm run typecheck
docker compose exec taskboards npm run lint
docker compose exec taskboards npm run test
docker compose exec taskboards npm run build
```

Run the continuous integration checks exactly as GitHub Actions runs them. The
script builds the Docker image, then runs typecheck, lint, tests, and the
production build in throwaway containers, plus the Compose configuration check.
It needs no running app and no embedding model:

```sh
scripts/ci.sh
scripts/ci.sh test lint
```

Rebuild the embedding index or run the embedding smoke test:

```sh
docker compose exec taskboards npm run embeddings:reindex
docker compose exec taskboards npm run test:embeddings
```

`scripts/check-compose-config.sh` renders the default, custom-port,
custom-storage, custom-model, and LAN configurations with
`docker compose config` and fails if any rendering is wrong.

[CONTRIBUTING.md](CONTRIBUTING.md) covers pull-request expectations.

## API Orientation

The JSON API is mounted under `/api`; the markdown-first agent API that the
wrapper uses is under `/api/agents`. Useful starting points:

- `GET /api/health`: API, database, and embedding model status.
- `GET /api/projects`: list active projects.
- `POST /api/projects`: create a project.
- `GET /api/projects/:projectId/boards`: list boards for a project.
- `POST /api/projects/:projectId/boards`: create a board.
- `GET /api/projects/:projectId/boards/:boardId?includeTasks=true`: read a
  board with tasks.
- `POST /api/projects/:projectId/boards/:boardId/tasks`: create a task.
- `POST /api/tasks/:taskId/move`: move a task to another column or sibling board.
- `POST /api/tasks/:taskId/comments`: append a task comment.
- `GET /api/tasks/:taskId/context`: fetch task, comments, activity, and parent
  board context.
- `POST /api/search`: run local semantic search over indexed board, task, and
  comment content.

Default workflow columns are `backlog`, `ready`, `in_progress`, `blocked`,
`review`, and `done`. See [docs/api.md](docs/api.md) for the full JSON
contract and [docs/agent-api.md](docs/agent-api.md) for the agent API.

## Documentation

- [docs/taskboards.md](docs/taskboards.md): product goals and workflows.
- [docs/tasks-and-boards.md](docs/tasks-and-boards.md): domain model.
- [docs/api.md](docs/api.md): JSON API structure.
- [docs/agent-api.md](docs/agent-api.md): markdown-first agent API design.
- [docs/prompts.md](docs/prompts.md): prompt library and prompt picker.
- [docs/ui.md](docs/ui.md): UI architecture and principles.
- [docs/text-embedding.md](docs/text-embedding.md): local embeddings and vector
  search.
- [docs/maintenance.md](docs/maintenance.md): archival, cleanup, and reindexing.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.

## Public Preview Status

v0.1.0 is a public preview: the API and UI may still change before a 1.0
release, and only the platforms and integrations named above have been
validated. Bug reports, setup problems, and
agent-integration feedback are welcome through the
[issue templates](https://github.com/WarehouseRobotics/agent-taskboards/issues/new/choose).
Security concerns go through [SECURITY.md](SECURITY.md), not public issues.

## Tech Stack

- React 19 and Vite for the UI.
- Express 4 for the API server.
- TypeScript across API and UI code.
- Drizzle ORM and SQLite for storage.
- `node-llama-cpp` and `sqlite-vec` for local semantic search.
- Docker Compose for normal local operation.
