#!/usr/bin/env node
// Checks and repairs package-lock.json completeness across platforms.
//
// npm silently prunes other platforms' optional dependencies (native builds of
// rollup, esbuild, sqlite-vec, node-llama-cpp, ...) when it rewrites the
// lockfile from an existing node_modules (https://github.com/npm/cli/issues/4828),
// and it can drop `resolved`/`integrity`. `npm ci` then fails or installs
// unverified tarballs on any platform other than the one that wrote the file.
//
//   node scripts/lockfile.mjs check   # exit 1 if entries are missing
//   node scripts/lockfile.mjs repair  # add them without changing any version
//
// `check` runs in CI through `scripts/ci.sh lockfile`. `repair` needs registry
// access; run it in a clean container, then let npm normalize the file:
//
//   docker run --rm -v "$PWD:/w" -w /w node:22.14-bookworm \
//     sh -c 'node scripts/lockfile.mjs repair && npm install --package-lock-only --ignore-scripts'
//
// Uses only Node built-ins so it runs before or without `npm ci`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const lockPath = new URL("../package-lock.json", import.meta.url);
const registry = "https://registry.npmjs.org";
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = lock.packages;

function packageName(path, entry) {
  return entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

// Locations Node would search for `name` when required from package `path`,
// nearest first. The root package has path "".
function searchPaths(path, name) {
  const paths = [];
  let dir = path;
  while (true) {
    paths.push(dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`);
    if (!dir) return paths;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut === -1 ? "" : dir.slice(0, cut);
  }
}

function resolveFrom(path, name) {
  return searchPaths(path, name).find((candidate) => packages[candidate]);
}

function installed(path, entry) {
  return path !== "" && !entry.link && !entry.inBundle;
}

function findProblems() {
  const missing = [];
  const unverified = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (installed(path, entry) && (!entry.resolved || !entry.integrity)) {
      unverified.push(path);
    }
    for (const [name, spec] of Object.entries(entry.optionalDependencies ?? {})) {
      const found = resolveFrom(path, name);
      const satisfied = found && (!exactVersion.test(spec) || packages[found].version === spec);
      if (!satisfied) missing.push({ parent: path, name, spec });
    }
  }
  return { missing, unverified };
}

async function fetchManifest(name, spec) {
  if (!exactVersion.test(spec)) {
    // Let npm resolve ranges (for example fsevents@~2.3.3) to the version it
    // would pick itself.
    spec = JSON.parse(execFileSync("npm", ["view", `${name}@${spec}`, "version", "--json"], { encoding: "utf8" }));
    if (Array.isArray(spec)) spec = spec.at(-1);
  }
  const response = await fetch(`${registry}/${name.replace("/", "%2f")}/${spec}`);
  if (!response.ok) throw new Error(`${name}@${spec}: registry returned ${response.status}`);
  return response.json();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

// Mirrors the fields npm 10 records for a registry package in lockfile v3.
function entryFromManifest(manifest, parent) {
  const scripts = manifest.scripts ?? {};
  const entry = {
    version: manifest.version,
    resolved: manifest.dist.tarball,
    integrity: manifest.dist.integrity,
  };
  if (parent.dev) entry.dev = true;
  if (parent.devOptional) entry.devOptional = true;
  entry.optional = true;
  if (scripts.preinstall || scripts.install || scripts.postinstall || manifest.gypfile) {
    entry.hasInstallScript = true;
  }
  if (manifest.bin) entry.bin = manifest.bin;
  if (manifest.license) entry.license = manifest.license;
  if (manifest.cpu) entry.cpu = manifest.cpu;
  if (manifest.os) entry.os = manifest.os;
  if (manifest.engines) entry.engines = manifest.engines;
  if (manifest.funding) entry.funding = manifest.funding;
  return entry;
}

async function repair() {
  // Shallow parents first, so shared versions land where npm would hoist them
  // and deeper parents with a different version nest below them.
  const depth = (path) => path.split("node_modules/").length;
  let added = 0;
  const { missing } = findProblems();
  missing.sort((a, b) => depth(a.parent) - depth(b.parent) || a.parent.localeCompare(b.parent));

  const manifests = await mapLimit(missing, 16, ({ name, spec }) => fetchManifest(name, spec));
  missing.forEach(({ parent, name }, index) => {
    const manifest = manifests[index];
    if (Object.keys(manifest.dependencies ?? {}).length > 0) {
      throw new Error(`${name}@${manifest.version} has dependencies; repair it by hand`);
    }
    const found = resolveFrom(parent, name);
    if (found && packages[found].version === manifest.version) return;
    // Shallowest location that resolves from the parent without replacing a
    // different version another package already uses.
    const candidates = searchPaths(parent, name).reverse();
    const blocked = found ? candidates.indexOf(found) : -1;
    const slot = candidates.slice(blocked + 1).find((candidate) => !packages[candidate]);
    if (!slot) throw new Error(`no free location for ${name} under ${parent}`);
    packages[slot] = entryFromManifest(manifest, packages[parent]);
    added++;
  });

  const unverified = Object.entries(packages).filter(
    ([path, entry]) => installed(path, entry) && (!entry.resolved || !entry.integrity),
  );
  await mapLimit(unverified, 16, async ([path, entry]) => {
    const manifest = await fetchManifest(packageName(path, entry), entry.version);
    entry.resolved = manifest.dist.tarball;
    entry.integrity = manifest.dist.integrity;
  });

  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`added ${added} missing optional entries, backfilled ${unverified.length} integrity hashes`);
}

function check() {
  const { missing, unverified } = findProblems();
  for (const { parent, name, spec } of missing) {
    console.error(`missing optional dependency ${name}@${spec} of ${parent || "(root)"}`);
  }
  for (const path of unverified) console.error(`missing resolved/integrity: ${path}`);
  if (missing.length || unverified.length) {
    console.error(
      `\npackage-lock.json is incomplete (${missing.length} missing, ${unverified.length} unverified).` +
        "\nRepair it with the command at the top of scripts/lockfile.mjs.",
    );
    process.exit(1);
  }
  console.log("package-lock.json lists every platform's optional dependencies with integrity hashes");
}

const mode = process.argv[2];
if (mode === "check") check();
else if (mode === "repair") await repair();
else {
  console.error("usage: node scripts/lockfile.mjs check|repair");
  process.exit(2);
}
