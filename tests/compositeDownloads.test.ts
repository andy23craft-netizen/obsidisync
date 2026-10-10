import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const Module = require("node:module");
const originalLoad = Module._load;
const mock = require(join(process.cwd(), "tests/e2e/obsidian-mock.js"));
let responder: (options: any) => Promise<any>;
const request = (options: any) => responder(options);
Module._load = function(name: string, ...rest: any[]) {
  return name === "obsidian" ? new Proxy(mock, { get: (target, key) => key === "requestUrl" ? request : target[key] })
    : originalLoad.call(this, name, ...rest);
};
const { GitService } = require("../src/gitService");
const { DEFAULT_SETTINGS } = require("../src/settings");
const { assertMountPrefixes, captureMountAction, assertMountAction, resolveMount, validateComposite } = require("../src/composite");
Module._load = originalLoad;
(globalThis as any).crypto ??= webcrypto;

const ids = ["s_" + "1".repeat(32), "s_" + "2".repeat(32), "s_" + "3".repeat(32)];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const ok = (json: any) => ({ status: 200, json, text: "" });

function fixture(t: any) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-tests", "mount-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "vault"), settingsPath = join(root, "settings.json");
  const vault = new mock.Vault(dir);
  let settings: any = { ...DEFAULT_SETTINGS, serverUrl: "http://localhost:8787", oidcAccessToken: "synthetic",
    userSlug: "andy", vaultSlug: "legacy", clientId: "mount-client", localManifest: [], historySnapshots: [], historyVersions: [] };
  let saveHook: (() => Promise<void>) | undefined;
  const save = async () => { const snapshot = JSON.stringify(settings); await saveHook?.(); writeFileSync(settingsPath, snapshot); };
  let service: any = new GitService(vault, settings, save);
  const remotes = ids.map(() => ({} as Record<string, string | Buffer>));
  const heads = ids.map(() => "head-1");
  const capabilities = ids.map(() => "read-write");
  const denied = new Set<number>();
  const requests: any[] = [];
  let hook: ((options: any) => Promise<void>) | undefined;
  let inline = false;
  let damagedBytes = false;
  responder = async (options: any) => {
    requests.push(options);
    await hook?.(options);
    const url = new URL(options.url);
    if (url.pathname === "/v1/server/info") return ok({ apiVersion: 1, minClientApiVersion: 1,
      features: ["shareSyncV2", "syncFileReferences"], version: "fixture", name: "fixture" });
    if (url.pathname === "/v1/auth/session") return ok({ user: "andy", subject: "p_andy" });
    if (url.pathname === "/v1/auth/config") return ok({ type: "password", passwordConfigured: true });
    if (url.pathname === "/v2/shares") return ok(ids.map((id, i) =>
      ({ shareId: id, label: `Share ${i}`, capability: capabilities[i] })));
    const index = ids.indexOf(url.pathname.split("/")[3]);
    assert.notEqual(index, -1, `Unexpected route ${options.method} ${url.pathname}`);
    if (denied.has(index)) return { status: 404, json: {}, text: "not found" };
    if (url.pathname.endsWith("/sync-state")) return ok({ shareId: ids[index], apiVersion: 2,
      capability: capabilities[index], serverHead: heads[index] });
    if (url.pathname.endsWith("/sync")) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.changes, []); assert.deepEqual(body.clientManifest, []); assert.equal(body.baseHead, null);
      return ok({ status: "ok", conflicts: [], serverHead: heads[index], files: Object.entries(remotes[index]).map(([path, bytes]) =>
        ({ path, op: "upsert", sha256: sha(bytes), size: Buffer.byteLength(bytes),
          ...(inline ? { contentBase64: Buffer.from(damagedBytes ? "damaged" : bytes).toString("base64") } : {}) })) });
    }
    if (url.pathname.endsWith("/blob")) {
      assert.equal(url.searchParams.get("hash"), heads[index]);
      const bytes = remotes[index][url.searchParams.get("path")!];
      assert.notEqual(bytes, undefined);
      return { ...ok({}), arrayBuffer: Uint8Array.from(Buffer.from(damagedBytes ? "damaged" : bytes)).buffer };
    }
    throw new Error(`Mutation/unexpected route ${options.method} ${url.pathname}`);
  };
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes);
  };
  return {
    dir, vault, requests, settings: () => settings, service: () => service,
    remote: (index: number, files: Record<string, string | Buffer>) => { remotes[index] = files; heads[index] += "-next"; },
    capabilities, denied, write,
    read: (path: string) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null,
    move: async (from: string, to: string) => { mkdirSync(dirname(join(dir, to)), { recursive: true });
      renameSync(join(dir, from), join(dir, to)); await service.observeCompositeRename(from, to); },
    add: async (index: number, prefix: string) => { await service.addCompositeMount(ids[index], prefix);
      return settings.composite.mounts.find((mount: any) => mount.shareId === ids[index]); },
    initialize: async (mount: any) => service.initializeCompositeMount(mount.mountId),
    restart: () => { settings = JSON.parse(readFileSync(settingsPath, "utf8")); service = new GitService(vault, settings, save); },
    hook: (value?: typeof hook) => { hook = value; }, saveHook: (value?: typeof saveHook) => { saveHook = value; },
    inline: () => { inline = true; }, corruptBytes: (value: boolean) => { damagedBytes = value; },
    saved: () => JSON.parse(readFileSync(settingsPath, "utf8"))
  };
}

test("prefix validation rejects overlap, case/Unicode aliases, duplicates and protected/traversing paths", () => {
  for (const prefix of ["", "/Personal", "../Personal", "Personal/../x", ".obsidian", "Personal/.trash", "Personal\\Notes"]) {
    assert.throws(() => assertMountPrefixes([{ localPrefix: prefix, shareId: ids[0] }]));
  }
  for (const prefix of ["Personal/Sub", "personal", "PERSONAL"]) assert.throws(() => assertMountPrefixes([
    { localPrefix: "Personal", shareId: ids[0] }, { localPrefix: prefix, shareId: ids[1] }]));
  assert.throws(() => assertMountPrefixes([{ localPrefix: "Cafe\u0301", shareId: ids[0] },
    { localPrefix: "Caf\u00e9", shareId: ids[1] }]));
  assert.throws(() => assertMountPrefixes([{ localPrefix: "A", shareId: ids[0] }, { localPrefix: "B", shareId: ids[0] }]));
  assert.doesNotThrow(() => assertMountPrefixes([{ localPrefix: "Personal", shareId: ids[0] }, { localPrefix: "Personal2", shareId: ids[1] }]));
});

test("fresh selection changes no files; two mounts isolate downloads, backup evidence and restart", async (t) => {
  const f = fixture(t);
  f.remote(0, { "same.md": "private", "image.bin": Buffer.from([0, 255, 17]) });
  f.remote(1, { "same.md": "shared" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  assert.equal(f.read("Personal/same.md"), null); await f.service().sync();
  assert.equal(f.read("Personal/same.md"), null, "background sync cannot initialize");
  f.write("Personal/same.md", "explicitly backed up");
  await f.initialize(a); await f.initialize(b);
  assert.equal(f.read("Personal/same.md"), "private"); assert.equal(f.read("Harmony/same.md"), "shared");
  assert.equal(f.read(`${a.download.initial.backupFolder}/Personal/same.md`), "explicitly backed up");
  assert.deepEqual(a.download.baseline.map((entry: any) => entry.path).sort(), ["image.bin", "same.md"]);
  assert.equal(f.settings().activeShare, undefined); assert.equal(f.settings().serverHead, null);
  assert.equal(resolveMount(f.settings().composite, "Personal2/same.md"), null);
  assert.equal(resolveMount(f.settings().composite, "Personal/same.md").mount.mountId, a.mountId);
  const token = captureMountAction(f.settings().composite, a);
  f.settings().composite.mounts.reverse();
  assert.equal(assertMountAction(f.settings(), token).mountId, a.mountId, "presentation order cannot change ownership");
  assert.equal(f.service().tracksLocalPath("root-local.md"), false);
  f.restart(); await f.service().sync();
  assert.equal(f.read("Personal/same.md"), "private");
  assert.equal(f.service().canWriteSelectedShare(), false);
  for (const req of f.requests) assert.equal(req.headers?.["x-obsidisync-client-features"], undefined);
  await assert.rejects(f.service().forcePushLocal(), /Composite/);
  await assert.rejects(f.service().history("Personal/same.md"), /not yet available/);
  await assert.rejects(f.service().listDevicePasswords(), /not yet available/);
});

test("existing files, history, recovery directories or legacy state require explicit conversion", async (t) => {
  const f = fixture(t);
  f.write("note.md", "keep");
  await assert.rejects(f.add(0, "Personal"), /empty vault/);
  rmSync(join(f.dir, "note.md"));
  f.settings().initialSyncDone = true;
  await assert.rejects(f.add(0, "Personal"), /explicit conversion/);
  f.settings().initialSyncDone = false;
  mkdirSync(join(f.dir, ".obsidian-git-sync"));
  await assert.rejects(f.add(0, "Personal"), /explicit conversion/);
  assert.equal(f.settings().composite, undefined);
});

test("protected remote configuration and InkVault source omission cannot delete local-only bytes", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal");
  f.remote(0, { ".obsidian/config.json": "remote", ".trash/private.md": "remote", ".inkvault/note.json": "source",
    "ObsidiSync History/note.md": "history", "export.pdf": "supported PDF" });
  f.write(".obsidian/config.json", "root config"); f.write("Personal/.obsidian/config.json", "local mount config");
  f.write("Personal/.inkvault/note.json", "local source"); f.write("unmounted.md", "local-only");
  await f.initialize(a); f.remote(0, {}); await f.service().sync();
  assert.equal(f.read(".obsidian/config.json"), "root config");
  assert.equal(f.read("Personal/.obsidian/config.json"), "local mount config");
  assert.equal(f.read("Personal/.inkvault/note.json"), "local source");
  assert.equal(f.read("unmounted.md"), "local-only"); assert.equal(f.read("Personal/export.pdf"), null);
});

test("unsafe remote paths and remote/local case aliases fail closed", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal");
  const invalidFiles: Array<Record<string, string>> = [{ "../escape.md": "bad" }, { "Note.md": "one", "note.md": "two" }];
  for (const files of invalidFiles) {
    f.remote(0, files); await assert.rejects(f.initialize(a), /Unsafe|alias/);
    assert.equal(f.read("escape.md"), null); assert.equal(f.read("Personal/Note.md"), null);
  }
  f.remote(0, { "Folder/note.md": "remote" }); f.write("Personal/folder/local.md", "keep");
  await f.initialize(a);
  assert.equal(f.read("Personal/folder/local.md"), "keep");
  assert.equal(f.read("Personal/Folder/note.md"), null);
  assert.ok(a.download.reconciliation.some((record: any) => record.path === "Folder/note.md"));
});

test("backup failure permits no application and retries use fresh verified backups", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal");
  f.write("Personal/note.md", "local"); f.remote(0, { "note.md": "remote" });
  const write = f.vault.adapter.writeBinary;
  f.vault.adapter.writeBinary = async (path: string, bytes: ArrayBuffer) => {
    if (path.startsWith(".obsidian-git-sync/")) throw new Error("fixture backup failure");
    return write(path, bytes);
  };
  await assert.rejects(f.initialize(a), /backup failure/); const failed = a.download.initial.backupFolder;
  assert.match(f.saved().composite.mounts[0].lastError, /backup failure/);
  assert.equal(f.read("Personal/note.md"), "local");
  f.vault.adapter.writeBinary = write; await f.initialize(a);
  assert.notEqual(a.download.initial.backupFolder, failed); assert.equal(f.read("Personal/note.md"), "remote");
});

for (const mode of ["reference", "inline"]) test(`${mode} checksum failure and edits after initial backup preserve mount bytes`, async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal");
  if (mode === "inline") f.inline();
  f.write("Personal/note.md", "local"); f.remote(0, { "note.md": "remote" }); f.corruptBytes(true);
  await assert.rejects(f.initialize(a), /checksum/);
  assert.equal(f.read("Personal/note.md"), "local"); assert.deepEqual(a.download.baseline, []);
  f.write("Personal/note.md", "edit after backup"); f.corruptBytes(false);
  await f.initialize(a);
  assert.equal(f.read("Personal/note.md"), "edit after backup"); assert.equal(a.download.reconciliation.length, 1);
  assert.equal(f.read(`${a.download.initial.backupFolder}/Personal/note.md`), "local");
});

test("mixed edits/deletions preserve local bytes while safe sibling downloads continue after denial", async (t) => {
  const f = fixture(t); f.remote(0, { "note.md": "base" }); f.remote(1, { "note.md": "base" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony"); await f.initialize(a); await f.initialize(b);
  f.write("Personal/note.md", "unsent"); f.write("Personal/new.md", "new");
  f.remote(0, {}); f.remote(1, { "note.md": "safe update" });
  await f.service().sync();
  assert.equal(f.read("Personal/note.md"), "unsent"); assert.equal(f.read("Personal/new.md"), "new");
  assert.equal(a.download.reconciliation.length, 2); assert.equal(f.read("Harmony/note.md"), "safe update");
  f.denied.add(0); f.remote(1, { "note.md": "later update" });
  await assert.rejects(f.service().sync(), /not found/);
  assert.equal(f.read("Harmony/note.md"), "later update"); assert.ok(a.lastError);
  assert.ok(!f.requests.some((req) => req.url.includes("/v1/users/")));
  f.denied.clear(); f.capabilities[0] = "read"; await f.service().sync();
  f.restart(); f.capabilities[0] = "read-write"; await f.service().sync();
  assert.equal(f.settings().composite.mounts[0].download.reconciliation.length, 2);
});

test("detected moves persist both barriers, invalidate stale transfers and leave third mount eligible", async (t) => {
  const f = fixture(t); for (let i = 0; i < 3; i++) f.remote(i, { "note.md": "base" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony"), c = await f.add(2, "Third");
  for (const mount of [a, b, c]) await f.initialize(mount);
  const token = captureMountAction(f.settings().composite, a);
  f.remote(0, { "note.md": "remote update" }); f.remote(2, { "note.md": "third update" });
  let moved = false;
  f.hook(async (req) => {
    if (!moved && req.url.includes(ids[0]) && req.url.includes("/blob")) {
      moved = true; await f.move("Personal/note.md", "Harmony/imported.md");
    }
  });
  await assert.rejects(f.service().sync(), /stale/);
  assert.throws(() => assertMountAction(f.settings(), token), /stale/);
  assert.equal(f.read("Personal/note.md"), null); assert.equal(f.read("Harmony/imported.md"), "base");
  assert.equal(f.read("Third/note.md"), "third update"); assert.equal(a.moveGeneration, 1); assert.equal(b.moveGeneration, 1);
  assert.equal(f.service().hasLocalBarrier("Harmony/imported.md"), true);
  f.hook(); f.restart(); await f.service().sync();
  assert.equal(f.read("Personal/note.md"), null); assert.equal(f.read("Harmony/imported.md"), "base");
  assert.ok(f.saved().composite.mounts[0].barriers.length);
});

test("folder/root and local-only moves are durable; same-mount rename does not advance generation", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  f.remote(0, { "folder/note.md": "base" }); await f.initialize(a); await f.initialize(b);
  await f.move("Personal/folder/note.md", "Personal/folder/renamed.md"); assert.equal(a.moveGeneration, 0);
  await f.move("Personal/folder", "local-folder"); assert.equal(a.moveGeneration, 1);
  await f.move("Personal", "renamed-root"); assert.ok(a.barriers.some((entry: any) => entry.path === ""));
  f.write(".git/local-only.md", "excluded bytes");
  await f.move(".git/local-only.md", "Harmony/imported.md");
  assert.equal(f.service().tracksLocalPath(".git/config"), false);
  assert.equal(f.service().hasLocalBarrier("Harmony/imported.md"), true);
  f.restart(); await f.service().sync(); assert.equal(f.read("Personal/folder/note.md"), null);
  assert.equal(f.read("local-folder/renamed.md"), "base");
});

test("save failure retains in-memory stop and generation evidence until retry saves it", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  f.remote(0, { "note.md": "base" }); await f.initialize(a); await f.initialize(b);
  f.saveHook(async () => { throw new Error("fixture save failure"); });
  await assert.rejects(f.move("Personal/note.md", "Harmony/note.md"), /could not be saved/);
  const token = captureMountAction(f.settings().composite, a);
  assert.throws(() => f.service().mountGuard(token)(), /persistence failed/);
  assert.equal(a.moveGeneration, 1); assert.equal(b.moveGeneration, 1);
  f.saveHook(); await f.service().sync(); f.restart(); await f.service().sync();
  assert.equal(f.read("Personal/note.md"), null); assert.equal(f.read("Harmony/note.md"), "base");
});

test("ambiguous disk application after a move does not acknowledge stale bytes and recovers conservatively", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  f.remote(0, { "note.md": "base" }); await f.initialize(a); await f.initialize(b);
  f.remote(0, { "note.md": "next" });
  const write = f.vault.adapter.writeBinary;
  let moved = false;
  f.vault.adapter.writeBinary = async (path: string, bytes: ArrayBuffer) => {
    await write(path, bytes);
    if (path === "Personal/note.md" && !moved) { moved = true; await f.move(path, "Harmony/imported.md"); }
  };
  await assert.rejects(f.service().sync(), /stale/);
  assert.equal(a.download.baseline[0].sha256, sha("base")); assert.ok(a.download.applying);
  f.vault.adapter.writeBinary = write; f.restart(); await f.service().sync();
  assert.equal(f.read("Harmony/imported.md"), "next"); assert.ok(f.settings().composite.mounts[0].download.reconciliation.length);
});

test("identity/configuration changes and corrupt composite schemas cannot fall back or clear state", async (t) => {
  const f = fixture(t), a = await f.add(0, "Personal"); f.remote(0, { "note.md": "base" }); await f.initialize(a);
  const token = captureMountAction(f.settings().composite, a);
  f.settings().authenticatedIdentity.subject = "another-user";
  await assert.rejects(f.service().sync(), /stale/); assert.equal(f.read("Personal/note.md"), "base");
  f.settings().authenticatedIdentity.subject = a.identity.subject;
  f.settings().composite.revision++;
  assert.throws(() => assertMountAction(f.settings(), token), /stale/);
  for (const corrupt of [null, { version: 99 }, { ...f.settings().composite, mounts: [] }]) {
    const previous = f.settings().composite; f.settings().composite = corrupt;
    assert.throws(() => validateComposite(f.settings()), /Invalid composite/);
    await assert.rejects(f.service().sync(), /Invalid composite/); f.settings().composite = previous;
  }
  assert.ok(!f.requests.some((req) => req.url.includes("/v1/users/")));
});
