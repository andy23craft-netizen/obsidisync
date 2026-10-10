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
const { FileHistoryView } = require("../src/fileHistoryView");
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
  const grants: any[][] = ids.map(() => []);
  let inline = false;
  let damagedBytes = false;
  let legacyHeader: string | undefined = "allowed";
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
    if (url.pathname.startsWith("/v1/users/") && url.pathname.endsWith("/device-passwords")) {
      if (options.method !== "GET") { assert.equal(legacyHeader, "allowed"); return ok({ id: "synthetic-legacy" }); }
      return { ...ok([]), headers: legacyHeader === undefined ? {} : { "x-obsidisync-legacy-grant-management": legacyHeader } };
    }
    if (url.pathname.startsWith("/v1/users/") && url.pathname.includes("/device-passwords/")) {
      assert.equal(options.method, "DELETE"); assert.equal(legacyHeader, "allowed"); return ok({});
    }
    const index = ids.indexOf(url.pathname.split("/")[3]);
    assert.notEqual(index, -1, `Unexpected route ${options.method} ${url.pathname}`);
    if (denied.has(index)) return { status: 404, json: {}, text: "not found" };
    if (url.pathname.endsWith("/sync-state")) return ok({ shareId: ids[index], apiVersion: 2,
      capability: capabilities[index], serverHead: heads[index] });
    if (url.pathname.endsWith("/history")) return ok([{ hash: heads[index], date: "2026-10-10T00:00:00Z", versionNumber: 1,
      message: `history ${index}`, subject: `history ${index}`, author: `author ${index}` }]);
    if (url.pathname.endsWith("/devices")) return ok([{ clientId: `device-${index}`, deviceName: `device ${index}` }]);
    if (url.pathname.endsWith("/files/device-versions")) return ok([{ clientId: `device-${index}`, hash: heads[index] }]);
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path")!, bytes = remotes[index][path];
      assert.equal(url.searchParams.get("hash"), heads[index]); assert.notEqual(bytes, undefined);
      return ok({ path, hash: heads[index], sha256: sha(bytes), readOnly: true,
        contentBase64: Buffer.from(damagedBytes ? "damaged" : bytes).toString("base64") });
    }
    if (url.pathname.endsWith("/files/version-metadata")) return ok({});
    if (url.pathname.includes("/device-passwords")) {
      if (options.method === "GET") return ok(grants[index]);
      if (options.method === "DELETE") { grants[index] = grants[index].filter((entry) => !url.pathname.endsWith(entry.id)); return ok({}); }
      const body = JSON.parse(options.body), id = `grant-${index}-${grants[index].length}`;
      const entry = { id, ...body, shareId: ids[index], lifecycle: "staged" };
      grants[index].push(entry);
      return ok({ ...entry, username: ids[index], password: "synthetic-once", webdavPath: `/dav/${ids[index]}/${body.folder}/`,
        nextcloudPath: `/remote.php/dav/files/${ids[index]}/${body.folder}/` });
    }
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
    legacyHeader: (value?: string) => { legacyHeader = value; },
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
  assert.equal((await f.service().history("Personal/same.md"))[0].message, "history 0");
  assert.deepEqual(await f.service().listDevicePasswords(), []);
});

test("history, blobs, devices and metadata resolve equal filenames to independent owning mounts", async (t) => {
  const f = fixture(t, true);
  f.remote(0, { "same.md": "private history", "same.bin": Buffer.from([0, 255]) });
  f.remote(1, { "same.md": "shared history" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony");
  await f.initialize(a); await f.initialize(b);
  for (const [prefix, mount, index] of [["Personal", a, 0], ["Harmony", b, 1]] as const) {
    const context = f.service().fileContext(`${prefix}/same.md`);
    assert.equal(context.mountId, mount.mountId); assert.equal(context.path, "same.md");
    const history = await f.service().history(`${prefix}/same.md`, context);
    assert.equal(history[0].message, `history ${index}`);
    assert.equal((await f.service().devices(mount.mountId))[0].clientId, `device-${index}`);
    assert.equal((await f.service().deviceVersions(`${prefix}/same.md`, context))[0].clientId, `device-${index}`);
    const bytes = await f.service().blobAtVersion(`${prefix}/same.md`, history[0].hash, context);
    assert.equal(Buffer.from(bytes).toString(), index === 0 ? "private history" : "shared history");
    await assert.rejects(f.service().saveVersionMetadata({ path: `${prefix}/same.md`, hash: history[0].hash, name: "denied" }, context), /read-only/);
    await f.service().enableShareWrites(mount.mountId);
    await f.service().saveVersionMetadata({ path: `${prefix}/same.md`, hash: history[0].hash, name: `name ${index}` }, context);
  }
  const mutations = f.requests.filter((request: any) => request.url.endsWith("/files/version-metadata"));
  assert.deepEqual(mutations.map((request: any) => JSON.parse(request.body).path), ["same.md", "same.md"]);
  assert.ok(mutations[0].url.includes(ids[0])); assert.ok(mutations[1].url.includes(ids[1]));
  const before = f.requests.length;
  assert.deepEqual(await f.service().history("outside.md"), []);
  assert.deepEqual(await f.service().deviceVersions("outside.md"), []);
  await assert.rejects(f.service().fileAtVersion("outside.md", "unused"), /Local-only/);
  assert.equal(f.requests.length, before);
  await assert.rejects(f.service().devices(), /name a composite mount/);
});

test("historical checksum failures and stale ownership stop reads and metadata without v1 fallback", async (t) => {
  const f = fixture(t, true); f.remote(0, { "same.md": "original" });
  const a = await f.add(0, "Personal"); await f.initialize(a); await f.service().enableShareWrites(a.mountId);
  const context = f.service().fileContext("Personal/same.md"), hash = (await f.service().history("Personal/same.md"))[0].hash;
  f.corruptBytes(true); await assert.rejects(f.service().fileAtVersion("Personal/same.md", hash), /checksum/); f.corruptBytes(false);
  let changed = false;
  f.afterHook(async (request: any) => {
    if (!changed && request.url.includes("/history?")) { changed = true; await f.service().observeCompositeRename("Personal/missing.md", "outside.md"); }
  });
  await assert.rejects(f.service().history("Personal/same.md", context), /stale/);
  f.afterHook();
  const count = f.requests.length;
  await assert.rejects(f.service().saveVersionMetadata({ path: "Personal/same.md", hash, name: "stale" }, context), /stale/);
  assert.equal(f.requests.length, count);
  f.denied.add(0); await assert.rejects(f.service().history("Personal/same.md"), (error: any) => error.status === 404);
  assert.ok(!f.requests.some((request: any) => request.url.includes("/v1/users/")));
});

test("historical restoration backs up current local bytes and retains reconciliation without changing siblings", async (t) => {
  const f = fixture(t, true); f.remote(0, { "same.md": "historical" }); f.remote(1, { "same.md": "shared" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony"); await f.initialize(a); await f.initialize(b);
  const sibling = JSON.stringify(b), baseline = JSON.stringify(a.download.baseline);
  f.write("Personal/same.md", "current edited bytes");
  const hash = (await f.service().history("Personal/same.md"))[0].hash;
  await f.service().restoreHistoricalFile("Personal/same.md", hash);
  assert.equal(f.read("Personal/same.md"), "historical");
  const record = a.download.reconciliation[0]; assert.equal(record.uploadBlocked, true);
  assert.equal(f.read(`${record.backupFolder}/Personal/same.md`), "current edited bytes");
  assert.equal(JSON.stringify(a.download.baseline), baseline); assert.equal(JSON.stringify(b), sibling);
  assert.equal(a.status, "download-only"); assert.equal(a.download.applying, undefined);
  a.download.writing = { stage: "submitted", entries: [{ path: "same.md", entry: a.download.baseline[0] }],
    mountAction: captureMountAction(f.settings().composite, a) };
  await assert.rejects(f.service().restoreHistoricalFile("Personal/same.md", hash), /Recover existing/);
  assert.equal(a.download.writing.stage, "submitted");
});

test("historical restore preserves edits after backup and leaves durable recovery evidence", async (t) => {
  const f = fixture(t); f.remote(0, { "same.md": "historical" });
  const mount = await f.add(0, "Personal"); await f.initialize(mount);
  f.write("Personal/same.md", "before backup");
  const hash = (await f.service().history("Personal/same.md"))[0].hash;
  const requestStart = f.requests.length;
  f.saveHook(async () => {
    if (mount.download.applying) f.write("Personal/same.md", "edit after backup");
  });
  await assert.rejects(f.service().restoreHistoricalFile("Personal/same.md", hash), /Local contents changed/);
  assert.equal(f.read("Personal/same.md"), "edit after backup");
  assert.equal(f.read(`${mount.download.applying.backupFolder}/Personal/same.md`), "before backup");
  f.saveHook(); f.restart();
  const restored = f.settings().composite.mounts[0];
  assert.ok(restored.download.applying);
  assert.equal(restored.download.reconciliation[0].uploadBlocked, true);
  assert.equal(restored.status, "download-only");
  assert.ok(f.requests.slice(requestStart).every((request: any) => request.method === "GET"));
});

test("snapshot ownership prevents sibling/unbound reuse and preserves edited root snapshots", async (t) => {
  const f = fixture(t); f.remote(0, { "same.md": "private" }); f.remote(1, { "same.md": "shared" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony"); await f.initialize(a); await f.initialize(b);
  const references: any[] = [];
  const view: any = Object.create(FileHistoryView.prototype);
  view.gitService = f.service(); view.filePath = "Personal/same.md";
  view.snapshots = { get: (path: string) => references.find((entry) => entry.snapshotPath === path),
    save: async (reference: any) => { references.push(reference); } };
  view.app = { vault: f.vault };
  f.vault.createFolder = async (path: string) => f.vault.adapter.mkdir(path);
  f.vault.createBinary = async (path: string, bytes: ArrayBuffer) => {
    assert.equal(await f.vault.adapter.exists(path), false); await f.vault.adapter.writeBinary(path, bytes);
    return f.vault.getAbstractFileByPath(path);
  };
  const context = f.service().fileContext("Personal/same.md");
  const entry = { hash: "equal-revision", date: "2026-10-10T00:00:00Z", versionNumber: 1, subject: "same revision", author: "fixture" };
  const bytes = new TextEncoder().encode("private").buffer;
  const first = await view.writeVersionSnapshot(entry, bytes, 1, context);
  assert.equal(references[0].ownership.mountId, a.mountId);
  assert.equal((await view.writeVersionSnapshot(entry, bytes, 1, context)).path, first.path);
  f.write(first.path, "edited local evidence");
  const second = await view.writeVersionSnapshot(entry, bytes, 1, context);
  assert.notEqual(second.path, first.path); assert.equal(f.read(first.path), "edited local evidence");
  const siblingContext = f.service().fileContext("Harmony/same.md");
  const third = await view.writeVersionSnapshot(entry, new TextEncoder().encode("shared").buffer, 1, siblingContext);
  assert.notEqual(third.path, first.path); assert.notEqual(third.path, second.path);
  assert.equal(f.service().snapshotOwnershipMatches("Harmony/same.md", context.ownership), false);
  references.push({ snapshotPath: "ObsidiSync History/unbound.md", sourcePath: "Personal/same.md", hash: "equal-revision" });
  assert.equal(view.resolveHistorySnapshot("ObsidiSync History/unbound.md").path, null);
  assert.equal(view.resolveHistorySnapshot(second.path).path, "Personal/same.md");
});

test("mount grant inventories and read issuance remain independent of file journals and stale actions", async (t) => {
  const f = fixture(t, true); f.remote(0, { "same.md": "private" }); f.remote(1, { "same.md": "shared" });
  const a = await f.add(0, "Personal"), b = await f.add(1, "Harmony"); await f.initialize(a); await f.initialize(b);
  f.capabilities[0] = "read";
  const before = JSON.stringify([a.download, b.download]);
  const created = await f.service().createShareCredential("Reader", "Tablet", "read", a.mountId);
  assert.equal(created.shareId, ids[0]); assert.equal(created.username, ids[0]); assert.equal(created.lifecycle, "staged");
  assert.equal(JSON.stringify([a.download, b.download]), before); assert.ok(!JSON.stringify(f.settings()).includes("synthetic-once"));
  await assert.rejects(f.service().createShareCredential("Writer", "Tablet", "read-write", a.mountId), /read-only/);
  await assert.rejects(f.service().revokeShareCredential(created.id, a.mountId), /host-operator/);
  assert.equal((await f.service().shareCredentialInventory(a.mountId)).entries.length, 1);
  assert.equal((await f.service().shareCredentialInventory(b.mountId)).entries.length, 0);
  await assert.rejects(f.service().shareCredentialInventory(), /name a composite mount/);
  let moved = false;
  f.afterHook(async (request: any) => {
    if (!moved && request.method === "POST" && request.url.endsWith("/device-passwords")) {
      moved = true; await f.service().observeCompositeRename("Harmony/missing.md", "outside.md");
    }
  });
  await assert.rejects(f.service().createShareCredential("Lost response", "Tablet", "read", b.mountId), /stale/);
  f.afterHook();
  assert.equal((await f.service().shareCredentialInventory(b.mountId)).entries.length, 1, "Review inventory; never automatically reissue a lost secret");
});

test("composite legacy mutations require the original namespace allowed header independent of mount capability", async (t) => {
  const f = fixture(t); const a = await f.add(0, "Personal");
  f.capabilities[0] = "read";
  for (const header of [undefined, "unknown", "denied", "allowed"]) {
    f.legacyHeader(header);
    const inventory = await f.service().legacyCredentialInventory();
    assert.deepEqual(inventory.entries, []); assert.equal(inventory.managementAllowed, header === "allowed");
    const start = f.requests.length;
    if (header === "allowed") {
      await f.service().createDevicePassword("Legacy", "Tablet"); await f.service().revokeDevicePassword("synthetic-legacy");
      assert.equal(f.requests.slice(start).filter((request: any) => request.method !== "GET").length, 2);
    } else {
      await assert.rejects(f.service().createDevicePassword("Legacy", "Tablet"), /allowed header/);
      await assert.rejects(f.service().revokeDevicePassword("synthetic-legacy"), /allowed header/);
      assert.ok(f.requests.slice(start).every((request: any) => request.method === "GET"));
    }
  }
  delete f.settings().legacyManagementContext;
  const before = f.requests.length;
  await assert.rejects(f.service().legacyCredentialInventory(), /Original legacy namespace/);
  assert.equal(f.requests.length, before); assert.equal(a.shareId, ids[0]);
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
