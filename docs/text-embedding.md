# Text Embeddings and Semantic Search

Agent Taskboards will use local text embeddings to make projects, boards, tasks,
and comments searchable as long-term memory for coding agents. The goal is to
let agents retrieve useful local context without sending task data to a hosted
embedding service.

## Stack

The v1 embedding stack is:

- `node-llama-cpp` for loading and running a local GGUF embedding model
- `models-gguf/bge-small-en-v1.5-f32.gguf` as the bundled embedding model
- SQLite for source-of-truth task data
- `sqlite-vec` for vector storage and nearest-neighbor search

This design keeps task data and embeddings on the developer's machine.

## Local Development Setup

The Docker image includes the native build tools needed by `node-llama-cpp`.
For development, keep the GGUF model on the host at:

```sh
models-gguf/bge-small-en-v1.5-f32.gguf
```

Compose mounts the host model directory read-only at `/models` inside the
container and sets `TASKBOARDS_EMBEDDING_MODEL_PATH` to
`/models/<TASKBOARDS_MODEL_FILE>`. Point Compose at a different directory or
file with `TASKBOARDS_MODEL_DIR` and `TASKBOARDS_MODEL_FILE` in `.env`. The
directory is ignored by git and Docker build context so model weights stay
local.

The container starts even when the selected file is missing. Semantic search
and indexing then fail with a "model file was not found" error until the file
exists, and `GET /api/health` reports the resolved `embedding.modelPath` with
`embedding.available` so the state is visible without reading logs.

The embedding wrapper defaults to CPU-only execution and disables runtime
downloads:

- `TASKBOARDS_EMBEDDING_MODEL_PATH` selects the model file inside the container
- default context size is 512 tokens
- indexed text is chunked conservatively to fit that limit
- default inference threads is 2

Run the local model smoke test inside the already-running container:

```sh
docker compose exec taskboards npm run test:embeddings
```

The smoke test loads the GGUF file, creates a 384-dimensional embedding, and
checks that two related task-board phrases are closer than unrelated text. If
the GGUF file is not present, the integration portion is skipped so regular
test runs do not require committing model weights.

## Indexed Content

The embedding index should cover content that helps humans and agents recover
project context:

- board names and descriptions
- task titles and descriptions
- task comments

Projects and activity are intentionally not indexed in the first implementation.

Each indexed chunk stores enough metadata to trace a search result back to
the canonical object: object type, object ID, project ID, board ID when
applicable, task ID when applicable, and timestamps.

Long indexed texts are split before embedding. Chunking is intentionally
conservative because the local embedding context defaults to 512 tokens and
`bge-small-en-v1.5` has the same practical maximum. The chunker estimates token
use by characters, targets roughly 390 tokens per chunk, and overlaps adjacent
chunks so nearby context is not lost at boundaries.

Chunking preserves markdown structure where possible:

- short fenced code or diagram blocks stay in one chunk
- short markdown tables stay in one chunk
- oversized blocks split only as a fallback, preferring line boundaries

Task chunks repeat compact task context, such as title, labels, and priority,
so each description chunk can stand alone in vector search. Boards and comments
keep their existing short-text shape when they fit in one chunk.

## Search Behavior

Semantic search should be exposed through the API as a retrieval primitive for
agents. A typical agent should be able to ask for related tasks or comments
before starting work, after encountering a blocker, or during handoff.

Search supports:

- global queries across active content
- scoped queries within a project or board
- optional inclusion of archived project and board content
- result limits
- compact snippets that explain why a result matched

Search results should be useful without requiring a second query, but they
should also include stable IDs so agents can fetch full canonical records.
When multiple chunks from the same board, task, or comment match, the API
returns the best matching chunk as a single result for that source. This keeps
long specifications from crowding out other relevant sources while preserving a
useful snippet.

## Index Lifecycle

Embeddings are created or refreshed inline after indexed text changes. A
developer maintenance script can force-rebuild all board embeddings plus active
task and comment embeddings:

```sh
docker compose exec taskboards npm run embeddings:reindex
```

Expected lifecycle events:

- create embeddings when boards, tasks, or comments are created
- update embeddings when indexed text changes
- remove stale chunk rows and vectors when text shrinks or chunk boundaries
  change
- delete task-scoped rows and vectors when a task is archived
- support full reindexing as a maintenance action

## Privacy and Limits

Embedding search is local-first. It should not require network calls during
normal operation. The app should favor predictable resource use over aggressive
background processing, because the expected environment is a developer laptop or
workstation running Docker.

The embedding system is a memory aid, not the source of truth. SQLite records
remain canonical; vector rows are derived data that can be rebuilt.
