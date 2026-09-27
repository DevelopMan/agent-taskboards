# Contributing to Agent Taskboards

Thanks for helping improve Agent Taskboards. This document explains how to set
up a development environment, run the checks, and open a pull request that is
easy to review and merge.

## Project Constraints

Agent Taskboards is intentionally local-first, single-user, MIT-licensed, free,
and telemetry-free. Contributions should preserve these constraints. Features
that require accounts, hosted services, or phoning home are out of scope; see
[SECURITY.md](SECURITY.md) for the security model behind them.

## Development Setup

Everything runs in Docker. Do not run `npm install` on the host machine;
dependencies are installed only inside the image, and the Dockerfile uses
`npm ci` against `package-lock.json`.

1. Clone the repository.
2. Optionally download the local embedding model as described in
   [README.md](README.md#manual-setup). The
   app and every check work without it; only semantic search needs it.
3. Start the app in debug (watch) mode:

   ```sh
   docker compose up --build
   ```

   The UI and API are served at `http://localhost:8142`. Vite and `tsx watch`
   pick up source changes without a rebuild.

Release mode, host-side configuration, and the runtime directories are
documented in the README under [Manual Setup](README.md#manual-setup) and
[Configuration](README.md#configuration).

## Running Checks

Run individual checks in the running container:

```sh
docker compose exec taskboards npm run typecheck
docker compose exec taskboards npm run lint
docker compose exec taskboards npm run test
docker compose exec taskboards npm run build
```

Before opening a pull request, run the full CI suite exactly as GitHub Actions
runs it. The script builds the Docker image, then runs typecheck, lint, the
test suite, and the production build in throwaway containers, plus the Compose
configuration check on the host. It needs no running app and no embedding
model:

```sh
scripts/ci.sh
```

`scripts/ci.sh test lint` runs a subset, and `--no-build` reuses the last
built image. CI runs the same checks on `linux/amd64` and `linux/arm64`;
macOS Apple Silicon and Linux x86-64 are the supported platforms.

## Pull Request Expectations

- Run `scripts/ci.sh` locally and make sure it passes before opening the PR.
- Keep changes scoped to one concern per pull request.
- Commit `package-lock.json` changes together with `package.json` changes;
  the image build fails when they drift apart.
- Update the documentation that your change affects: `README.md`, the
  relevant `docs/*.md` files, and `CHANGELOG.md`.
- Reference the issue the PR addresses, when one exists.
- Write commit messages with a short imperative subject line, matching the
  existing history.

## Getting Help

- Setup problems: open a
  [setup help issue](https://github.com/WarehouseRobotics/agent-taskboards/issues/new?template=setup-help.yml).
- Bugs: open a
  [bug report](https://github.com/WarehouseRobotics/agent-taskboards/issues/new?template=bug-report.yml).
- Agent integration friction (Claude Code, Codex, the wrapper, or the HTTP
  API): open an
  [agent integration issue](https://github.com/WarehouseRobotics/agent-taskboards/issues/new?template=agent-integration.yml).
- Security concerns: see [SECURITY.md](SECURITY.md). Please do not open
  public issues for suspected vulnerabilities.

When sharing command output or logs, redact anything private first. Never
paste real task content, credentials, `.env` values, or files from `data/`
(the SQLite database) into an issue or pull request.
