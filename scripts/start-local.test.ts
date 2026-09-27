import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface DockerCall {
  args: string[];
  debug: string | null;
  bind: string | null;
}

// The suite runs the real script against a throwaway copy of the repo layout
// with stubbed `docker` and `curl` on PATH, so it works both on developer
// machines and inside the CI image where Docker is unavailable. sha256
// verification is exercised with the real sha256sum/shasum tool against a
// small GGUF-magic fixture served by the curl stub.
describe("start-local.sh", () => {
  const sourceScript = resolve(process.cwd(), "scripts/start-local.sh");

  let tmpDir: string;
  let repoDir: string;
  let binDir: string;
  let scriptPath: string;
  let dockerLog: string;
  let curlLog: string;
  let fixturePath: string;
  let manifestPath: string;
  let fixture: Buffer;
  let fixtureSha: string;

  const modelFile = "bge-small-en-v1.5-q8_0.gguf";
  const happyInput = "1\n\n\n\n\n";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "start-local-"));
    repoDir = join(tmpDir, "repo");
    binDir = join(tmpDir, "bin");
    mkdirSync(join(repoDir, "scripts"), { recursive: true });
    mkdirSync(binDir);
    scriptPath = join(repoDir, "scripts", "start-local.sh");
    copyFileSync(sourceScript, scriptPath);
    chmodSync(scriptPath, 0o755);

    dockerLog = join(tmpDir, "docker.log");
    curlLog = join(tmpDir, "curl.log");

    fixture = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(4096, 7)]);
    fixtureSha = createHash("sha256").update(fixture).digest("hex");
    fixturePath = join(tmpDir, "fixture.gguf");
    writeFileSync(fixturePath, fixture);

    manifestPath = join(tmpDir, "manifest.txt");
    const entries = [
      ["q8", "bge-small-en-v1.5-q8_0.gguf"],
      ["q4", "bge-small-en-v1.5-q4_k_m.gguf"],
      ["f16", "bge-small-en-v1.5-f16.gguf"],
      ["f32", "bge-small-en-v1.5-f32.gguf"],
    ]
      .map(
        ([key, file]) =>
          `${key}|${file}|${fixture.length}|${fixtureSha}|http://example.invalid/${file}`,
      )
      .join("\n");
    writeFileSync(manifestPath, `${entries}\n`);

    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const debug = "TASKBOARDS_DEBUG" in process.env ? process.env.TASKBOARDS_DEBUG : null;
const bind = "TASKBOARDS_BIND_ADDRESS" in process.env ? process.env.TASKBOARDS_BIND_ADDRESS : null;
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, debug, bind }) + "\\n");
const mode = process.env.FAKE_DOCKER_MODE || "ok";
if (args[0] === "compose" && args[1] === "version" && mode === "nocompose") process.exit(1);
if (args[0] === "info" && mode === "nodaemon") process.exit(1);
process.exit(0);
`,
    );
    chmodSync(join(binDir, "docker"), 0o755);

    writeFileSync(
      join(binDir, "curl"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let out = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-o") out = args[index + 1];
}
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ args }) + "\\n");
const mode = process.env.FAKE_CURL_MODE || "success";
if (mode === "fail") process.exit(22);
const fixture = fs.readFileSync(process.env.FAKE_CURL_FIXTURE);
if (mode === "corrupt") {
  fs.writeFileSync(out, Buffer.from("GGUF not the pinned bytes"));
  process.exit(0);
}
if (mode === "hang") {
  fs.writeFileSync(out, fixture.subarray(0, Math.floor(fixture.length / 2)));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(out, fixture);
  process.exit(0);
}
`,
    );
    chmodSync(join(binDir, "curl"), 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function childEnv(overrides: Record<string, string> = {}) {
    return {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_CURL_LOG: curlLog,
      FAKE_CURL_FIXTURE: fixturePath,
      TASKBOARDS_MODEL_MANIFEST: manifestPath,
      ...overrides,
    };
  }

  function runSetup(
    args: string[],
    input: string,
    overrides: Record<string, string> = {},
  ) {
    return spawnSync(scriptPath, args, {
      input,
      env: childEnv(overrides),
      encoding: "utf8",
      cwd: repoDir,
    });
  }

  function envFile() {
    return readFileSync(join(repoDir, ".env"), "utf8");
  }

  function envEntries() {
    return envFile()
      .split("\n")
      .filter((line) => line.includes("="));
  }

  function dockerCalls(): DockerCall[] {
    if (!existsSync(dockerLog)) return [];
    return readFileSync(dockerLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerCall);
  }

  function curlCallCount() {
    if (!existsSync(curlLog)) return 0;
    return readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean).length;
  }

  function seedValidState() {
    writeFileSync(
      join(repoDir, ".env"),
      [
        "# my own note",
        "MY_KEY=1",
        "TASKBOARDS_DEBUG=1",
        "TASKBOARDS_PORT=8142",
        "TASKBOARDS_BIND_ADDRESS=127.0.0.1",
        "TASKBOARDS_DATA_DIR=./data",
        "TASKBOARDS_UPLOADS_DIR=./uploads",
        "TASKBOARDS_MODEL_DIR=./models-gguf",
        `TASKBOARDS_MODEL_FILE=${modelFile}`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(repoDir, "models-gguf"), { recursive: true });
    writeFileSync(join(repoDir, "models-gguf", modelFile), fixture);
  }

  it("configures, downloads, verifies, and launches release mode on the happy path", () => {
    const result = runSetup([], happyInput);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const env = envFile();
    expect(env).toContain("TASKBOARDS_PORT=8142");
    expect(env).toContain("TASKBOARDS_BIND_ADDRESS=127.0.0.1");
    expect(env).toContain("TASKBOARDS_DATA_DIR=./data");
    expect(env).toContain("TASKBOARDS_UPLOADS_DIR=./uploads");
    expect(env).toContain("TASKBOARDS_MODEL_DIR=./models-gguf");
    expect(env).toContain(`TASKBOARDS_MODEL_FILE=${modelFile}`);
    expect(env).not.toContain("TASKBOARDS_DEBUG");

    expect(existsSync(join(repoDir, "data"))).toBe(true);
    expect(existsSync(join(repoDir, "uploads"))).toBe(true);
    const installed = readFileSync(join(repoDir, "models-gguf", modelFile));
    expect(installed.equals(fixture)).toBe(true);
    expect(existsSync(join(repoDir, "models-gguf", `${modelFile}.partial`))).toBe(false);

    const up = dockerCalls().at(-1);
    expect(up?.args).toEqual(["compose", "up", "--build"]);
    expect(up?.debug).toBe("");
  });

  it("passes extra arguments through to docker compose up", () => {
    const result = runSetup(["-d"], happyInput);

    expect(result.status).toBe(0);
    expect(dockerCalls().at(-1)?.args).toEqual(["compose", "up", "--build", "-d"]);
  });

  it("re-prompts on invalid port answers and keeps the valid one", () => {
    const result = runSetup([], "1\nabc\n70000\n8200\n\n\n\n");

    expect(result.status).toBe(0);
    expect(envFile()).toContain("TASKBOARDS_PORT=8200");
  });

  it("fails with a recovery command after repeated invalid answers, leaving no config", () => {
    const result = runSetup([], "9\n9\n9\n9\n9\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain("Recovery:");
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
  });

  it("keeps localhost when LAN exposure is not confirmed with a literal yes", () => {
    const result = runSetup([], "1\n\n2\ny\n\n\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("UNAUTHENTICATED");
    expect(envFile()).toContain("TASKBOARDS_BIND_ADDRESS=127.0.0.1");
  });

  it("binds to the LAN only after the literal yes acknowledgement", () => {
    const result = runSetup([], "1\n\n2\nyes\n\n\n");

    expect(result.status).toBe(0);
    expect(envFile()).toContain("TASKBOARDS_BIND_ADDRESS=0.0.0.0");
  });

  it("leaves existing configuration untouched when the download fails", () => {
    const sentinel = "# sentinel\nMY_KEY=1\n";
    writeFileSync(join(repoDir, ".env"), sentinel);

    const result = runSetup([], happyInput, { FAKE_CURL_MODE: "fail" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("download failed");
    expect(result.stderr).toContain("Recovery:");
    expect(envFile()).toBe(sentinel);
    expect(existsSync(join(repoDir, "models-gguf", modelFile))).toBe(false);
    expect(existsSync(join(repoDir, "models-gguf", `${modelFile}.partial`))).toBe(false);
  });

  it("rejects a corrupted download and preserves the existing model file", () => {
    const oldModel = Buffer.from("GGUF old model bytes");
    mkdirSync(join(repoDir, "models-gguf"), { recursive: true });
    writeFileSync(join(repoDir, "models-gguf", modelFile), oldModel);

    // Extra trailing newline accepts the default Y on the re-download prompt.
    const result = runSetup([], "1\n\n\n\n\n\n", { FAKE_CURL_MODE: "corrupt" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wrong size");
    expect(result.stderr).toContain("Recovery:");
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
    expect(existsSync(join(repoDir, "models-gguf", `${modelFile}.partial`))).toBe(false);
    const kept = readFileSync(join(repoDir, "models-gguf", modelFile));
    expect(kept.equals(oldModel)).toBe(true);
  });

  it("rejects a download whose digest does not match the pinned one", () => {
    // Same byte length as the fixture so the size pre-check passes and the
    // sha256 comparison is what fails.
    const wrongBytes = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(4096, 9)]);
    writeFileSync(fixturePath, wrongBytes);
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(
      manifestPath,
      manifest.replaceAll(`|${fixture.length}|`, `|${wrongBytes.length}|`),
    );

    const result = runSetup([], happyInput);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("digest verification");
    expect(result.stderr).toContain("Recovery:");
    expect(existsSync(join(repoDir, "models-gguf", modelFile))).toBe(false);
    expect(existsSync(join(repoDir, "models-gguf", `${modelFile}.partial`))).toBe(false);
  });

  it("cleans up the partial file when the download is interrupted", async () => {
    const child = spawn(scriptPath, [], {
      env: childEnv({ FAKE_CURL_MODE: "hang" }),
      cwd: repoDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(happyInput);
    child.stdin.end();

    const partial = join(repoDir, "models-gguf", `${modelFile}.partial`);
    const deadline = Date.now() + 10_000;
    while (!existsSync(partial)) {
      if (Date.now() > deadline) throw new Error("partial file never appeared");
      await new Promise((r) => setTimeout(r, 25));
    }
    process.kill(-child.pid!, "SIGINT");

    const status = await new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => resolveExit(code));
    });

    expect(status).not.toBe(0);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(join(repoDir, "models-gguf", modelFile))).toBe(false);
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
  }, 15_000);

  it("verifies an existing model instead of redownloading it", () => {
    mkdirSync(join(repoDir, "models-gguf"), { recursive: true });
    writeFileSync(join(repoDir, "models-gguf", modelFile), fixture);

    const result = runSetup([], happyInput);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping download");
    expect(curlCallCount()).toBe(0);
  });

  it("accepts a custom GGUF path, splitting it into directory and file name", () => {
    const customDir = join(tmpDir, "custom models", "dir with space");
    mkdirSync(customDir, { recursive: true });
    const customPath = join(customDir, "my-model.gguf");
    writeFileSync(customPath, Buffer.from("GGUF custom model"));

    // A nonexistent path first proves the validation re-prompt works.
    const result = runSetup([], `5\n${join(tmpDir, "missing.gguf")}\n${customPath}\n\n\n\n\n`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Not a readable GGUF file");
    const env = envFile();
    expect(env).toContain(`TASKBOARDS_MODEL_DIR=${customDir}`);
    expect(env).toContain("TASKBOARDS_MODEL_FILE=my-model.gguf");
    expect(curlCallCount()).toBe(0);
  });

  it("reuses a valid existing configuration without prompting", () => {
    seedValidState();
    const before = envFile();

    const result = runSetup([], "");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Reusing the existing configuration");
    expect(result.stdout).not.toContain("Embedding model");
    expect(envFile()).toBe(before);
    expect(dockerCalls().at(-1)?.args).toEqual(["compose", "up", "--build"]);
    expect(dockerCalls().at(-1)?.debug).toBe("");
  });

  it("rewrites only managed keys on --reconfigure, preserving unrelated entries", () => {
    seedValidState();
    const modelPath = join(repoDir, "models-gguf", modelFile);

    const result = runSetup(["--reconfigure"], `5\n${modelPath}\n9000\n\n\n\n`);

    expect(result.status).toBe(0);
    const env = envFile();
    expect(env).toContain("# my own note");
    expect(env).toContain("MY_KEY=1");
    expect(env).toContain("TASKBOARDS_DEBUG=1");
    expect(env).toContain("TASKBOARDS_PORT=9000");
    expect(env).toContain(`TASKBOARDS_MODEL_FILE=${modelFile}`);
    for (const key of [
      "TASKBOARDS_PORT",
      "TASKBOARDS_BIND_ADDRESS",
      "TASKBOARDS_DATA_DIR",
      "TASKBOARDS_UPLOADS_DIR",
      "TASKBOARDS_MODEL_DIR",
      "TASKBOARDS_MODEL_FILE",
    ]) {
      const occurrences = envEntries().filter((line) => line.startsWith(`${key}=`));
      expect(occurrences).toHaveLength(1);
    }
    // The reconfigured model dir is the absolute path of the chosen file.
    expect(env).toContain(`TASKBOARDS_MODEL_DIR=${join(repoDir, "models-gguf")}`);
  });

  it("reuses the configuration written by a previous run without redownloading", () => {
    const first = runSetup([], happyInput);
    expect(first.status).toBe(0);
    const envAfterFirst = envFile();
    rmSync(curlLog, { force: true });

    const second = runSetup([], "");

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Reusing the existing configuration");
    expect(envFile()).toBe(envAfterFirst);
    expect(curlCallCount()).toBe(0);
  });

  it("exports the resolved settings so inherited shell variables cannot override them", () => {
    const result = runSetup([], happyInput, { TASKBOARDS_BIND_ADDRESS: "0.0.0.0" });

    expect(result.status).toBe(0);
    expect(envFile()).toContain("TASKBOARDS_BIND_ADDRESS=127.0.0.1");
    const up = dockerCalls().at(-1);
    expect(up?.args).toEqual(["compose", "up", "--build"]);
    expect(up?.bind).toBe("127.0.0.1");
  });

  it("rejects a manifest whose file name escapes the model directory", () => {
    writeFileSync(
      manifestPath,
      `q8|../evil.gguf|${fixture.length}|${fixtureSha}|http://example.invalid/evil.gguf\n`,
    );

    const result = runSetup([], happyInput);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe file name");
    expect(result.stderr).toContain("Recovery:");
    expect(existsSync(join(repoDir, "evil.gguf"))).toBe(false);
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
  });

  it("preserves restrictive .env permissions across a reconfigure", () => {
    seedValidState();
    chmodSync(join(repoDir, ".env"), 0o600);

    const result = runSetup(["--reconfigure"], `5\n${join(repoDir, "models-gguf", modelFile)}\n9000\n\n\n\n`);

    expect(result.status).toBe(0);
    expect(statSync(join(repoDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("re-prompts directory answers containing .env-unsafe characters", () => {
    const result = runSetup([], "1\n\n\n./data$dir\n./data\n\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("must not contain");
    expect(envFile()).toContain("TASKBOARDS_DATA_DIR=./data");
    expect(envFile()).not.toContain("data$dir");
  });

  it("resolves a symlinked custom model to its real directory", () => {
    const realDir = join(tmpDir, "real-models");
    mkdirSync(realDir, { recursive: true });
    const realPath = join(realDir, "real-model.gguf");
    writeFileSync(realPath, Buffer.from("GGUF real model"));
    const linkDir = join(tmpDir, "links");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(realPath, join(linkDir, "linked.gguf"));

    const result = runSetup([], `5\n${join(linkDir, "linked.gguf")}\n\n\n\n\n`);

    expect(result.status).toBe(0);
    const env = envFile();
    expect(env).toContain(`TASKBOARDS_MODEL_DIR=${realDir}`);
    expect(env).toContain("TASKBOARDS_MODEL_FILE=real-model.gguf");
  });

  it("fails before touching anything when docker is missing", () => {
    rmSync(join(binDir, "docker"));

    const result = runSetup([], happyInput);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker is not installed");
    expect(result.stderr).toContain("Recovery:");
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
  });

  it("fails with distinct messages for missing compose and a stopped daemon", () => {
    const noCompose = runSetup([], happyInput, { FAKE_DOCKER_MODE: "nocompose" });
    expect(noCompose.status).toBe(1);
    expect(noCompose.stderr).toContain("docker compose v2 is not available");

    const noDaemon = runSetup([], happyInput, { FAKE_DOCKER_MODE: "nodaemon" });
    expect(noDaemon.status).toBe(1);
    expect(noDaemon.stderr).toContain("the Docker daemon is not running");
    expect(existsSync(join(repoDir, ".env"))).toBe(false);
  });
});
