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

function fixture(t: any, writable = false) {
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
  let afterHook: ((options: any) => Promise<void>) | undefined;
  const uploads = new Map<string, { index: number; path: string; sha256: string; bytes: Buffer }>();
  let uploadSequence = 0;
  const conflicts: any[][] = ids.map(() => []);
  let inline = false;
  let damagedBytes = false;
  const respond = async (options: any) => {
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
    if (writable && url.pathname.endsWith("/conflicts")) return ok(conflicts[index]);
    if (writable && url.pathname.includes("/uploads")) {
      const body = JSON.parse(options.body);
      if (url.pathname.endsWith("/uploads")) {
        const uploadId = `upload-${uploadSequence++}`;
        uploads.set(uploadId, { index, path: body.path, sha256: body.sha256, bytes: Buffer.alloc(0) });
        return ok({ uploadId, chunkSize: 3 });
      }
      const uploadId = url.pathname.split("/")[5];
      const upload = uploads.get(uploadId)!;
      assert.equal(upload.index, index);
      if (url.pathname.endsWith("/chunk")) {
        assert.equal(body.offset, upload.bytes.length);
        upload.bytes = Buffer.concat([upload.bytes, Buffer.from(body.contentBase64, "base64")]);
        return ok({ received: upload.bytes.length });
      }
      assert.equal(sha(upload.bytes), upload.sha256);
      return ok({ uploadId, sha256: upload.sha256, size: upload.bytes.length });
    }
    if (writable && (url.pathname.endsWith("/sync") || url.pathname.endsWith("/resolve"))) {
      const body = JSON.parse(options.body);
      const changes = body.changes ?? body.files.map((file: any) => ({ ...file, op: file.delete ? "delete" : "upsert" }));
      for (const change of changes) {
        if (change.op === "delete") delete remotes[index][change.path];
        else {
          const upload = uploads.get(change.uploadId)!;
          assert.equal(upload.index, index); assert.equal(upload.path, change.path);
          remotes[index][change.path] = upload.bytes;
          uploads.delete(change.uploadId);
        }
      }
      if (changes.length) heads[index] += "-commit";
      if (body.files) conflicts[index] = conflicts[index].filter((file) => !changes.some((change: any) => change.path === file.path));
      return ok({ status: "ok", conflicts: [], serverHead: heads[index], files: Object.entries(remotes[index]).map(([path, bytes]) =>
        ({ path, op: "upsert", sha256: sha(bytes), size: Buffer.byteLength(bytes) })) });
    }
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
  responder = async (options: any) => { const response = await respond(options); await afterHook?.(options); return response; };
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes);
  };
  return {
    dir, vault, requests, settings: () => settings, service: () => service,
    remote: (index: number, files: Record<string, string | Buffer>) => { remotes[index] = files; heads[index] += "-next"; },
    capabilities, denied, conflicts, write,
    remoteFiles: (index: number) => Object.fromEntries(Object.entries(remotes[index]).map(([path, bytes]) => [path, Buffer.from(bytes).toString("utf8")])),
    read: (path: string) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null,
    move: async (from: string, to: string) => { mkdirSync(dirname(join(dir, to)), { recursive: true });
      renameSync(join(dir, from), join(dir, to)); await service.observeCompositeRename(from, to); },
    add: async (index: number, prefix: string) => { await service.addCompositeMount(ids[index], prefix);
      return settings.composite.mounts.find((mount: any) => mount.shareId === ids[index]); },
    initialize: async (mount: any) => service.initializeCompositeMount(mount.mountId),
    restart: () => { settings = JSON.parse(readFileSync(settingsPath, "utf8")); service = new GitService(vault, settings, save); },
    hook: (value?: typeof hook) => { hook = value; }, saveHook: (value?: typeof saveHook) => { saveHook = value; },
    afterHook: (value?: typeof afterHook) => { afterHook = value; },
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

async function writableMounts(t: any, count = 2) {
  const f = fixture(t, true);
  const mounts = [];
  for (let i = 0; i < count; i++) {
    f.remote(i, { "same.md": `base ${i}`, "delete.md": "delete me", "image.bin": "binary base" });
    const mount = await f.add(i, ["Personal", "Harmony", "Third"][i]);
    await f.initialize(mount); await f.service().enableShareWrites(mount.mountId); mounts.push(mount);
  }
  return { f, mounts };
}

test("writable mounts isolate text, deletion and binary capture and retain edits during transfer", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "personal edit"); f.write("Harmony/same.md", "shared edit");
  f.write("Personal/image.bin", Buffer.from([0, 1, 255]));
  rmSync(join(f.dir, "Harmony/delete.md")); f.write("local-only.md", "never uploaded");
  let edited = false;
  let stagingSame = false;
  f.hook(async (options) => {
    if (options.url.includes(ids[0]) && options.url.endsWith("/uploads")) stagingSame = JSON.parse(options.body).path === "same.md";
    if (!edited && stagingSame && options.url.includes(`${ids[0]}/uploads/`) && options.url.endsWith("/chunk")) {
      edited = true; f.write("Personal/same.md", "new edit during transfer");
    }
  });
  await f.service().sync();
  assert.equal(f.remoteFiles(0)["same.md"], "personal edit");
  assert.equal(f.remoteFiles(1)["same.md"], "shared edit");
  assert.equal(f.remoteFiles(1)["delete.md"], undefined);
  assert.equal(f.remoteFiles(0)["image.bin"], Buffer.from([0, 1, 255]).toString("utf8"));
  assert.equal(f.read("Personal/same.md"), "new edit during transfer");
  assert.ok(mounts[0].download.reconciliation.some((file: any) => file.path === "same.md"));
  assert.ok(mounts.every((mount: any) => mount.download.baseline.every((file: any) => !file.path.includes("Personal/") && !file.path.includes("Harmony/"))));
  assert.ok(!Object.keys(f.remoteFiles(0)).includes("local-only.md"));
});

test("initial mount upload replaces only the named share including remote-only deletion", async (t) => {
  const f = fixture(t, true);
  f.remote(0, { "old.md": "remote only", "same.md": "remote" }); f.remote(1, { "keep.md": "sibling" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  f.write("Personal/same.md", "initial local"); f.write("Personal/pic.bin", "binary");
  f.write("Harmony/untouched.md", "local sibling");
  await f.service().initializeShareUpload(a.mountId);
  assert.deepEqual(f.remoteFiles(0), { "same.md": "initial local", "pic.bin": "binary" });
  assert.deepEqual(f.remoteFiles(1), { "keep.md": "sibling" }); assert.equal(b.initialized, false);
  assert.equal(f.read("Harmony/untouched.md"), "local sibling");
  assert.equal(a.status, "writable"); assert.equal(a.download.initial.backupManifest.length, 2);
  await assert.rejects(f.service().initializeShareUpload(a.mountId), /cannot be repeated/);
});

for (const stage of ["/uploads", "/chunk", "/complete", "/sync"]) {
  test(`move after dispatch at ${stage} retains original journal; current recovery keeps barriers and third mount works`, async (t) => {
    const { f, mounts } = await writableMounts(t, 3);
    f.write("Personal/same.md", "captured private bytes"); f.write("Third/same.md", "third edit");
    let moved = false;
    f.afterHook(async (options) => {
      if (moved || !options.url.includes(ids[0]) || !options.url.endsWith(stage)) return;
      if (stage === "/sync" && !JSON.parse(options.body).changes.length) return;
      moved = true; await f.move("Personal/same.md", "Harmony/moved.md");
    });
    await assert.rejects(f.service().sync(), /stale/);
    assert.ok(moved);
    const journal = mounts[0].download.writing;
    assert.equal(journal.entries[0].entry.sha256, sha("captured private bytes"));
    assert.equal(journal.stage, stage === "/sync" ? "submitted" : "staging");
    assert.equal(journal.mountAction.mountId, mounts[0].mountId);
    assert.equal(journal.mountAction.moveGeneration, 0);
    assert.equal(mounts[0].download.baseline.find((file: any) => file.path === "same.md").sha256, sha("base 0"));
    assert.equal(f.remoteFiles(2)["same.md"], "third edit");
    assert.equal(f.remoteFiles(1)["moved.md"], undefined);
    f.afterHook(); f.restart();
    await f.service().sync();
    const recovered = f.settings().composite.mounts[0];
    assert.ok(recovered.barriers.length); assert.ok(f.settings().composite.mounts[1].barriers.length);
    assert.equal(recovered.download.writing, undefined);
    if (stage === "/sync") assert.equal(recovered.download.baseline.find((file: any) => file.path === "same.md").sha256, sha("captured private bytes"));
    else {
      const original = recovered.download.reconciliation.find((file: any) => file.path === "same.md").capturedWrite;
      assert.equal(original.stage, "staging"); assert.equal(original.mountAction.moveGeneration, 0);
    }
    assert.equal(f.remoteFiles(0)["same.md"], stage === "/sync" ? "captured private bytes" : "base 0");
    assert.equal(f.remoteFiles(1)["moved.md"], undefined);
  });
}

test("move during write-journal save stops upload initialization before dispatch", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "private staged");
  let moved = false;
  const before = f.requests.length;
  f.saveHook(async () => {
    if (!moved && mounts[0].download.writing?.stage === "staging") {
      moved = true; await f.move("Personal/same.md", "Harmony/moved.md");
    }
  });
  await assert.rejects(f.service().sync(), /stale/);
  assert.ok(!f.requests.slice(before).some((request) => request.url.includes("/uploads")));
  assert.equal(f.remoteFiles(0)["same.md"], "base 0");
});

test("lost write response recovers exact captures without replaying upload IDs; divergence preserves evidence", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "lost accepted");
  let lost = false;
  f.afterHook(async (options) => {
    if (!lost && options.url.includes(ids[0]) && options.url.endsWith("/sync") && JSON.parse(options.body).changes.length) {
      lost = true; throw new Error("synthetic lost response");
    }
  });
  await assert.rejects(f.service().sync(), /lost response/);
  assert.equal(mounts[0].download.writing.stage, "submitted");
  const count = f.requests.filter((request) => request.url.endsWith("/uploads")).length;
  f.afterHook(); f.restart(); await f.service().sync();
  assert.equal(f.requests.filter((request) => request.url.endsWith("/uploads")).length, count);
  assert.equal(f.settings().composite.mounts[0].download.writing, undefined);
  f.write("Personal/same.md", "uncertain capture"); lost = false;
  f.afterHook(async (options) => {
    if (!lost && options.url.includes(ids[0]) && options.url.endsWith("/sync") && JSON.parse(options.body).changes.length) {
      lost = true; f.remote(0, { "same.md": "another writer" }); throw new Error("lost divergent");
    }
  });
  await assert.rejects(f.service().sync(), /lost divergent/); f.afterHook(); f.restart();
  await f.service().sync();
  const record = f.settings().composite.mounts[0].download.reconciliation.find((file: any) => file.path === "same.md");
  assert.equal(record.capturedWrite.entry.sha256, sha("uncertain capture"));
  assert.equal(record.capturedWrite.stage, "submitted"); assert.equal(f.read("Personal/same.md"), "uncertain capture");
});

test("downgrade during chunks stops writes and restoration never uploads retained edits implicitly", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "retained private edit"); f.write("Harmony/same.md", "sibling write");
  let changed = false;
  f.afterHook(async (options) => {
    if (!changed && options.url.includes(ids[0]) && options.url.endsWith("/chunk")) { changed = true; f.capabilities[0] = "read"; }
  });
  await assert.rejects(f.service().sync(), /read-only/);
  assert.equal(f.remoteFiles(0)["same.md"], "base 0"); assert.equal(f.remoteFiles(1)["same.md"], "sibling write");
  f.afterHook(); f.capabilities[0] = "read-write"; f.restart(); await f.service().sync();
  assert.equal(f.remoteFiles(0)["same.md"], "base 0");
  const mount = f.settings().composite.mounts[0];
  await f.service().keepLocalReconciliation("same.md", mount.mountId); await f.service().sync();
  assert.equal(f.remoteFiles(0)["same.md"], "base 0");
  await f.service().uploadLocalReconciliation("same.md", mount.mountId);
  assert.equal(f.remoteFiles(0)["same.md"], "retained private edit");
  assert.equal(mount.download.reconciliation.length, 0);
});

test("explicit move endpoint reconciliation releases only that endpoint and Keep local retains upload consent barrier", async (t) => {
  const { f, mounts } = await writableMounts(t);
  await f.move("Personal/same.md", "Harmony/moved.md");
  const move = f.settings().composite.moves[0];
  await f.service().reconcileCompositeMove(mounts[1].mountId, move.id, "moved.md", "keep-local");
  assert.equal(mounts[1].barriers.length, 0); assert.equal(mounts[0].barriers.length, 1);
  await f.service().sync(); assert.equal(f.remoteFiles(1)["moved.md"], undefined);
  assert.equal(f.remoteFiles(0)["same.md"], "base 0");
  await f.service().uploadLocalReconciliation("moved.md", mounts[1].mountId);
  assert.equal(f.remoteFiles(1)["moved.md"], "base 0"); assert.equal(f.remoteFiles(0)["same.md"], "base 0");
  await f.service().reconcileCompositeMove(mounts[0].mountId, move.id, "same.md", "use-remote");
  assert.equal(f.read("Personal/same.md"), "base 0"); assert.equal(f.settings().composite.moves.length, 0);
});

test("per-mount server resolution captures binary bytes and does not alter sibling baselines", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.conflicts[0] = [{ path: "image.bin", reason: "binary conflict" }];
  f.write("Personal/image.bin", "local binary choice");
  const sibling = JSON.stringify(mounts[1].download);
  await f.service().resolveConflicts([{ path: "image.bin", kind: "current" }], mounts[0].mountId);
  assert.equal(f.remoteFiles(0)["image.bin"], "local binary choice");
  assert.equal(JSON.stringify(mounts[1].download), sibling);
  assert.deepEqual(await f.service().pendingConflicts(mounts[0].mountId), []);
});

for (const stage of ["/uploads", "/chunk", "/complete", "/sync", "/resolve"]) {
  test(`original mount authority is rechecked after async token preparation before ${stage} dispatch`, async (t) => {
    const { f, mounts } = await writableMounts(t);
    f.write("Personal/same.md", "private new bytes");
    if (stage === "/resolve") f.conflicts[0] = [{ path: "same.md", reason: "pending" }];
    const service = f.service();
    const original = service.refreshExpiringOidcAccessToken.bind(service);
    let trigger = false, moved = false;
    // requestWithAuth awaits this preparation after capture, immediately before the actual send.
    service.refreshExpiringOidcAccessToken = async () => {
      await original();
      if (trigger && !moved) { moved = true; await f.move("Personal/same.md", "Harmony/moved.md"); }
    };
    const transport = service.requestWithAuth.bind(service);
    service.requestWithAuth = async (method: string, path: string, ...args: any[]) => {
      if (path.includes(ids[0]) && path.endsWith(stage)) {
        const body = args[0];
        if (stage !== "/sync" || body?.changes?.length) trigger = true;
      }
      return transport(method, path, ...args);
    };
    const before = f.requests.length;
    const work = stage === "/resolve" ? service.resolveConflicts([{ path: "same.md", kind: "current" }], mounts[0].mountId)
      : service.sync();
    await assert.rejects(work, /stale/);
    assert.ok(moved);
    assert.ok(!f.requests.slice(before).some((request) => request.url.includes(ids[0]) && request.url.endsWith(stage) &&
      (stage !== "/sync" || JSON.parse(request.body).changes.length)));
    assert.equal(f.remoteFiles(0)["same.md"], "base 0"); assert.equal(f.remoteFiles(1)["moved.md"], undefined);
  });
}

test("HTTP 403 after writable negotiation persists barriers and retains staging evidence", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "denied edit"); f.write("Harmony/same.md", "allowed sibling");
  const original = responder;
  responder = async (options) => options.url.includes(ids[0]) && options.url.endsWith("/chunk")
    ? { status: 403, json: {}, text: "synthetic capability denial" } : original(options);
  await assert.rejects(f.service().sync(), /denial/);
  assert.equal(mounts[0].capability, "read"); assert.equal(mounts[0].download.writing.stage, "staging");
  assert.ok(mounts[0].download.reconciliation.some((file: any) => file.path === "same.md"));
  assert.equal(f.remoteFiles(1)["same.md"], "allowed sibling");
  responder = original; f.restart(); await f.service().sync(); assert.equal(f.remoteFiles(0)["same.md"], "base 0");
});

test("failed initial-upload backup and activation never authorize background replacement", async (t) => {
  const f = fixture(t, true);
  f.remote(0, { "remote.md": "retain remote" });
  const mount = await f.add(0, "Personal"); f.write("Personal/local.md", "retain local");
  const original = f.vault.adapter.writeBinary.bind(f.vault.adapter);
  f.vault.adapter.writeBinary = async (path: string, bytes: ArrayBuffer) => {
    if (path.includes("/backups/")) throw new Error("synthetic backup failure");
    return original(path, bytes);
  };
  await assert.rejects(f.service().initializeShareUpload(mount.mountId), /backup failure/);
  assert.equal(mount.initialized, false); assert.equal(mount.status, "download-only");
  await f.service().sync(); assert.deepEqual(f.remoteFiles(0), { "remote.md": "retain remote" });
  f.vault.adapter.writeBinary = original;
  f.saveHook(async () => { if (mount.initialized) throw new Error("synthetic activation save failure"); });
  await assert.rejects(f.service().initializeShareUpload(mount.mountId), /activation save/);
  assert.equal(mount.initialized, false); assert.equal(mount.status, "download-only");
  f.saveHook(); await f.service().sync(); assert.deepEqual(f.remoteFiles(0), { "remote.md": "retain remote" });
  assert.ok(mount.download.initial.backupManifest); assert.ok(mount.download.writing);
  f.restart(); await f.service().sync(); assert.deepEqual(f.remoteFiles(0), { "remote.md": "retain remote" });
});

test("failed write-enable save stays download-only and stale modal guards cannot approve a later generation", async (t) => {
  const f = fixture(t, true);
  f.remote(0, { "same.md": "base" });
  const mount = await f.add(0, "Personal"); await f.initialize(mount);
  f.saveHook(async () => { if (mount.status === "writable") throw new Error("synthetic enable save failure"); });
  await assert.rejects(f.service().enableShareWrites(mount.mountId), /enable save/);
  assert.equal(mount.status, "download-only"); f.saveHook();
  const oldModal = f.service().compositeActionGuard(mount.mountId);
  await f.move("Personal/same.md", "local.md");
  assert.throws(oldModal, /stale/);
  f.restart(); assert.equal(f.settings().composite.mounts[0].status, "download-only");
});

test("a failed endpoint release restores its barrier, while explicit upload authorizes only that source deletion", async (t) => {
  const { f, mounts } = await writableMounts(t);
  await f.move("Personal/same.md", "Harmony/moved.md");
  const move = f.settings().composite.moves[0];
  f.saveHook(async () => { if (!mounts[0].barriers.length) throw new Error("synthetic release failure"); });
  await assert.rejects(f.service().reconcileCompositeMove(mounts[0].mountId, move.id, "same.md", "keep-local"), /release failure/);
  assert.equal(mounts[0].barriers.length, 1); assert.equal(mounts[1].barriers.length, 1);
  f.saveHook(); await f.service().reconcileCompositeMove(mounts[0].mountId, move.id, "same.md", "upload-local");
  assert.equal(f.remoteFiles(0)["same.md"], undefined); assert.equal(f.remoteFiles(1)["moved.md"], undefined);
  assert.equal(mounts[1].barriers.length, 1); assert.equal(f.read("Harmony/moved.md"), "base 0");
  assert.equal(mounts[0].download.reconciliation.length, 0);
});

test("malformed persisted write captures fail closed without transport or v1 fallback", async (t) => {
  const { f, mounts } = await writableMounts(t);
  const count = f.requests.length;
  mounts[0].download.writing = { stage: "submitted", entries: [{ path: "same.md", entry: { path: "other.md", sha256: sha("x"), size: 1, mtime: 0 } }] };
  assert.throws(() => validateComposite(f.settings()), /Invalid composite/);
  await assert.rejects(f.service().sync(), /Invalid composite/);
  assert.equal(f.requests.length, count); assert.ok(mounts[0].download.writing);
});

for (const change of ["server", "account", "revision"]) {
  test(`${change} change during staging cannot reuse old writable captures or fall back to v1`, async (t) => {
    const { f, mounts } = await writableMounts(t);
    f.write("Personal/same.md", "old context capture");
    let changed = false;
    f.afterHook(async (options) => {
      if (changed || !options.url.includes(ids[0]) || !options.url.endsWith("/chunk")) return;
      changed = true;
      if (change === "server") f.settings().serverUrl = "http://localhost:9999";
      if (change === "account") f.settings().authenticatedIdentity.subject = "different-account";
      if (change === "revision") f.settings().composite.revision++;
    });
    await assert.rejects(f.service().sync(), /stale|changed/);
    assert.equal(mounts[0].download.writing.stage, "staging");
    assert.equal(f.remoteFiles(0)["same.md"], "base 0");
    assert.ok(!f.requests.some((request) => request.url.includes("/v1/users/")));
  });
}

test("move during accepted-journal persistence cannot advance captured baselines", async (t) => {
  const { f, mounts } = await writableMounts(t);
  f.write("Personal/same.md", "accepted original capture");
  let moved = false;
  f.saveHook(async () => {
    if (!moved && mounts[0].download.writing?.stage === "accepted") {
      moved = true; await f.move("Personal/same.md", "Harmony/moved.md");
    }
  });
  await assert.rejects(f.service().sync(), /stale/);
  assert.equal(mounts[0].download.writing.stage, "accepted");
  assert.equal(mounts[0].download.baseline.find((file: any) => file.path === "same.md").sha256, sha("base 0"));
  assert.equal(f.remoteFiles(0)["same.md"], "accepted original capture");
  f.saveHook(); f.restart(); await f.service().sync();
  assert.equal(f.settings().composite.mounts[0].download.baseline.find((file: any) => file.path === "same.md").sha256, sha("accepted original capture"));
  assert.ok(f.settings().composite.mounts[0].barriers.length); assert.ok(f.settings().composite.mounts[1].barriers.length);
});
