// End-to-end harness: real rust server + the plugin's GitService under Node.
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

// Runs the real Rust server (debug build) and drives the plugin's GitService from Node through a
// small Obsidian stand-in. Opt-in: `npm run test:e2e` (needs cargo build + tsc test output).
const REPO = path.resolve(__dirname, "..", "..");
const SCRATCH = path.join(REPO, ".tmp-tests", "e2e");
fs.mkdirSync(SCRATCH, { recursive: true });
const mockPath = path.join(__dirname, "obsidian-mock.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "obsidian") return mockPath;
  return originalResolve.call(this, request, ...rest);
};
globalThis.window = globalThis;

const obsidian = require("obsidian");
const { GitService } = require(path.join(REPO, ".tmp-tests/src/gitService.js"));
const { DEFAULT_SETTINGS } = require(path.join(REPO, ".tmp-tests/src/settings.js"));

const PORT = 18787;
const SERVER = `http://127.0.0.1:${PORT}`;
let TOKEN;
let SHARE_ID;
const PASSWORD = "synthetic-harness-password-123";
const USER = "dev";
const VAULT = "harness";
const DATA_DIR = path.join(SCRATCH, "server-data");

function device(name) {
  const dir = path.join(SCRATCH, "vaults", name);
  fs.rmSync(dir, { recursive: true, force: true });
  const vault = new obsidian.Vault(dir, name);
  const settings = {
    ...DEFAULT_SETTINGS,
    serverUrl: SERVER,
    oidcAccessToken: TOKEN,
    userSlug: USER,
    vaultSlug: VAULT,
    clientId: `client-${name}`,
    deviceName: name,
    localManifest: [],
    historySnapshots: [],
    historyVersions: []
  };
  const service = new GitService(vault, settings, async () => {});
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : null);
  return { name, dir, vault, settings, service, write, read };
}

function pending() {
  const file = path.join(DATA_DIR, "shares", SHARE_ID, "pending-conflicts.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function serverFile(rel) {
  const file = path.join(DATA_DIR, "shares", SHARE_ID, "repo", rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

async function startServer() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const binary = path.join(REPO, "rust-server/target/debug/obsidian-git-sync-server");
  function admin(args, input) {
    const result = spawnSync(binary, ["admin", "--data-dir", DATA_DIR, ...args], { input, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture administration failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  const account = admin(["account", "create", USER], `${PASSWORD}\n`);
  const share = admin(["share", "create", "Synthetic harness share"]);
  SHARE_ID = share.id;
  admin(["membership", "grant", share.id, "local", account.id, "read-write"]);
  admin(["publication", "initialize"]);
  const setup = path.join(SCRATCH, "setup.json");
  fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
    authorName: "Synthetic Harness", authorEmail: "fixture@example.invalid" },
    mapping: { user: USER, vault: VAULT, share_id: share.id,
      principals: [{ kind: "local", account_id: account.id }], native_enabled: true, dav_enabled: true } }));
  admin(["share", "setup", share.id, setup]);
  const child = spawn(path.join(REPO, "rust-server/target/debug/obsidian-git-sync-server"), [], {
    env: {
      ...process.env,
      OBSIDIAN_GIT_SYNC_LISTEN: `127.0.0.1:${PORT}`,
      OBSIDIAN_GIT_SYNC_DATA_DIR: DATA_DIR,
      OBSIDIAN_GIT_SYNC_AUTH_MODE: "password",
      RUST_LOG: "warn"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${SERVER}/v1/server/info`);
      if (response.ok) {
        const login = await fetch(`${SERVER}/v1/auth/password/login`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASSWORD }) });
        if (!login.ok) throw new Error("fixture login failed");
        TOKEN = (await login.json()).accessToken;
        return child;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("server did not start");
}

const log = (...args) => console.log(...args);
const show = (label, value) => log(`  ${label}:`, JSON.stringify(value));

async function main() {
  const server = await startServer();
  try {
    await (require(path.join(__dirname, process.argv[2] || "scenario-conflicts.js")))({ device, pending, serverFile, log, show, obsidian });
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error("HARNESS FAILED:", error);
  process.exitCode = 1;
});
