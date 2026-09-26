# Security Policy

## Security Model

Agent Taskboards is intentionally a single-user, local-first application. The
API and UI have **no authentication, no API keys, and no rate limiting**. This
is a design boundary, not a vulnerability: the app assumes it is reachable
only by the person who runs it.

Everything the app stores stays on your machine: the SQLite database in
`data/`, uploaded files in `uploads/`, and the embedding model in
`models-gguf/`. There is no telemetry and no hosted component.

## Localhost Is the Safe Default

By default the published port binds to `127.0.0.1`, so only local processes
can reach the app. Exposing it to a network is an explicit operator decision:
setting `TASKBOARDS_BIND_ADDRESS=0.0.0.0` gives **anyone who can reach your
machine on the network full read and write access to every board, task,
comment, and upload**, because the server performs no authentication.

Keep the default loopback binding unless you trust the entire network. For
remote access, prefer an SSH tunnel or a reverse proxy that adds its own
authentication in front of the app. `TASKBOARDS_API_KEY` in the agent skill is
a client-side setting for proxies that require a bearer token; the server
itself does not check it.

## Reporting a Vulnerability

If you find a way to make the server misbehave beyond this documented
boundary — for example path traversal through uploads or the model path,
script injection in the UI, or any issue that affects a default
loopback-bound installation — please report it privately:

1. Go to the repository's **Security** tab on GitHub.
2. Choose **Report a vulnerability** to open a private advisory:
   <https://github.com/WarehouseRobotics/agent-taskboards/security/advisories/new>

Please do not open public issues for suspected vulnerabilities. Reports that
describe the absence of authentication on a LAN-exposed installation are the
documented design boundary above and will be redirected here.

When reporting, describe the reproduction with synthetic data. Do not include
real task content, credentials, `.env` values, or your SQLite database files;
a minimal set of steps or a script that reproduces the problem on a fresh
installation is ideal.

## Supported Versions

The v0.1.x public preview line receives best-effort fixes. There are no
long-term support branches; fixes land on `main` and ship in the next tagged
release.
