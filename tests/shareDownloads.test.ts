import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const Module = require("node:module");
const originalLoad = Module._load;
const baseMock = require(join(process.cwd(), "tests/e2e/obsidian-mock.js"));
let responder: (request: any) => Promise<any>;
const mock = new Proxy(baseMock, { get: (target, key) => key === "requestUrl" ? responder : target[key] });
// Keep the request function stable while each disposable fixture supplies its own responder.
const request = async (options: any) => responder(options);
Module._load = function(name: string, ...rest: any[]) {
  return name === "obsidian" ? new Proxy(mock, { get: (target, key) => key === "requestUrl" ? request : target[key] })
    : originalLoad.call(this, name, ...rest);
};
const { GitService } = require("../src/gitService");
const { DEFAULT_SETTINGS } = require("../src/settings");
Module._load = originalLoad;
(globalThis as any).crypto ??= webcrypto;

const id = "s_0123456789abcdef0123456789abcdef";
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const ok = (json: any) => ({ status: 200, json, text: "" });

function fixture(t: any) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-tests", "04b-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "vault");
  const vault = new baseMock.Vault(dir);
  let settings: any = { ...DEFAULT_SETTINGS, serverUrl: "http://localhost:8787", oidcAccessToken: "synthetic",
    userSlug: "andy", vaultSlug: "legacy", clientId: "test-client", initialSyncDone: true, serverHead: "legacy-head",
    localManifest: [{ path: "legacy.md", sha256: "legacy-hash", size: 1, mtime: 1 }], historySnapshots: [], historyVersions: [] };
  let service: any;
  const requests: any[] = [];
  let remote: Record<string, string | Buffer> = {};
  let head = "h1";
  let capability = "read-write";
  let hook: ((options: any) => Promise<void>) | undefined;
  let deny = 0;
  let inline = false;
  let after: ((options: any) => Promise<void>) | undefined;
  const uploads = new Map<string, { path: string; sha256: string; bytes: Buffer }>();
  const versions = new Map<string, Record<string, string | Buffer>>();
  const save = async () => writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  const make = () => { service = new GitService(vault, settings, save); return service; };
  make();
  responder = async (options: any) => {
    requests.push(options);
    await hook?.(options);
    const url = new URL(options.url);
    if (url.pathname.startsWith("/v2/shares/") && deny) return { status: deny, json: {}, text: "unavailable" };
    if (url.pathname === "/v1/server/info") return ok({ apiVersion: 1, minClientApiVersion: 1,
      features: ["shareSyncV2", "syncFileReferences", "inkVaultNotesV1"], version: "fixture", name: "fixture" });
    if (url.pathname === "/v1/auth/session") return ok({ user: "andy", subject: "p_andy" });
    if (url.pathname === "/v1/auth/config") return ok({ type: "password", passwordConfigured: true });
    if (url.pathname === "/v2/shares") return ok([{ shareId: id, label: "Synthetic", capability }]);
    if (url.pathname.endsWith("/sync-state")) return ok({ shareId: id, capability, apiVersion: 2, serverHead: head });
    if (url.pathname.endsWith("/sync")) {
      const body = JSON.parse(options.body);
      if (body.changes.length) {
        if (capability !== "read-write") return { status: 403, json: {}, text: "read-only" };
        for (const change of body.changes) {
          if (change.op === "delete") delete remote[change.path];
          else {
            const upload = uploads.get(change.uploadId)!;
            assert.equal(sha(upload.bytes), upload.sha256);
            remote[change.path] = upload.bytes;
            uploads.delete(change.uploadId);
          }
        }
        head += "-write";
      } else {
        assert.deepEqual(body.clientManifest, []);
        assert.equal(body.baseHead, null);
      }
      versions.set(head, { ...remote });
      await after?.(options);
      return ok({ status: "ok", conflicts: [], serverHead: head, files: Object.entries(remote).map(([path, text]) =>
        ({ path, op: "upsert", sha256: sha(text), ...(inline ? { contentBase64: Buffer.from(text).toString("base64") } : {}) })) });
    }
    if (url.pathname.endsWith("/conflicts")) return ok([]);
    if (url.pathname.includes("/uploads")) {
      if (capability !== "read-write") return { status: 403, json: {}, text: "read-only" };
      const body = JSON.parse(options.body);
      if (url.pathname.endsWith("/uploads")) {
        const uploadId = `upload-${uploads.size}`;
        uploads.set(uploadId, { ...body, bytes: Buffer.alloc(0) });
        return ok({ uploadId, chunkSize: 3 });
      }
      const uploadId = url.pathname.split("/").slice(-2)[0];
      const upload = uploads.get(uploadId)!;
      if (url.pathname.endsWith("/chunk")) {
        assert.equal(body.offset, upload.bytes.length);
        upload.bytes = Buffer.concat([upload.bytes, Buffer.from(body.contentBase64, "base64")]);
        return ok({ uploadId, received: upload.bytes.length });
      }
      return ok({ uploadId, sha256: sha(upload.bytes), size: upload.bytes.length });
    }
    if (url.pathname.endsWith("/blob")) {
      const value = versions.get(url.searchParams.get("hash")!)?.[url.searchParams.get("path")!];
      assert.notEqual(value, undefined);
      return { ...ok({}), arrayBuffer: Uint8Array.from(Buffer.from(value!)).buffer };
    }
    if (url.pathname.endsWith("/history") || url.pathname.endsWith("/files/device-versions")) return ok([]);
    if (url.pathname.endsWith("/file")) return ok({ path: url.searchParams.get("path"), hash: head,
      contentBase64: Buffer.from("remote").toString("base64"), sha256: sha("remote"), readOnly: true });
    throw new Error(`Unexpected request ${options.method} ${url.pathname}`);
  };
  return {
    dir, vault, requests, service: () => service, settings: () => settings,
    remote: (files: Record<string, string | Buffer>, version = "h1") => { remote = files; head = version; },
    capability: (value: string) => { capability = value; }, hook: (value?: typeof hook) => { hook = value; },
    deny: (status: number) => { deny = status; }, inline: () => { inline = true; },
    after: (value?: typeof after) => { after = value; },
    remoteFiles: () => remote,
    write: (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); },
    read: (path: string) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null,
    remove: (path: string) => rmSync(join(dir, path)),
    initialize: async () => { await service.stageShareSelection(id); await service.initializeShareDownload(); },
    restart: () => { settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")); return make(); },
    saved: () => JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))
  };
}

function onlyReads(f: ReturnType<typeof fixture>) {
  for (const request of f.requests) {
    assert.ok(!/register|uploads|resolve|version-metadata|\/v1\/users\//.test(request.url), request.url);
    assert.ok(!request.method || request.method === "GET" || (request.method === "POST" && request.url.endsWith("/sync")));
    assert.equal(request.headers?.["x-obsidisync-client-features"], undefined, "InkVault source access stays gated");
  }
}

test("explicit initial download verifies backup, preserves v1 settings, and supports share history without writes", async (t) => {
  const f = fixture(t);
  f.write("grocery.md", "local"); f.write("local-only.md", "keep in backup");
  f.remote({ "grocery.md": "remote", "attachment.bin": Buffer.from([0, 255, 17]) });
  await f.service().stageShareSelection(id);
  const old = JSON.stringify([f.settings().serverHead, f.settings().localManifest]);
  await assert.rejects(f.service().sync(), /not enabled/);
  await f.service().initializeShareDownload();
  assert.equal(f.read("grocery.md"), "remote");
  assert.equal(f.read("local-only.md"), null);
  const folder = f.settings().activeShare.download.initial.backupFolder;
  assert.equal(f.read(`${folder}/grocery.md`), "local");
  assert.equal(f.read(`${folder}/local-only.md`), "keep in backup");
  assert.equal(JSON.stringify([f.settings().serverHead, f.settings().localManifest]), old);
  assert.equal(f.service().lastSynchronizedAt(), f.settings().activeShare.download.lastDownloadedAt);
  assert.equal(f.settings().lastSyncedAt, null, "Legacy timestamp remains owned by v1");
  await f.service().history("grocery.md"); await f.service().deviceVersions("grocery.md");
  await f.service().fileAtVersion("grocery.md", "h1");
  for (const operation of [() => f.service().forcePushLocal(), () => f.service().resolveConflicts([{ path: "grocery.md", kind: "delete" }]),
    () => f.service().saveVersionMetadata({ path: "grocery.md", hash: "h1" })]) await assert.rejects(operation(), /not enabled|writable share access|read-only/);
  onlyReads(f);
});

test("mixed safe downloads preserve edited files, local deletion, new files, and remote deletion conflicts", async (t) => {
  const f = fixture(t);
  f.remote({ "edit.md": "base", "safe.md": "base", "deleted.md": "base", "remote-delete.md": "base" });
  await f.initialize();
  f.write("edit.md", "unsent"); f.remove("deleted.md"); f.write("new.md", "offline new");
  f.write("remote-delete.md", "unsent deletion overlap");
  f.remote({ "edit.md": "new remote", "safe.md": "safe update", "deleted.md": "remote update" }, "h2");
  f.capability("read"); await f.service().sync();
  assert.equal(f.read("edit.md"), "unsent"); assert.equal(f.read("safe.md"), "safe update");
  assert.equal(f.read("deleted.md"), null); assert.equal(f.read("new.md"), "offline new");
  assert.equal(f.read("remote-delete.md"), "unsent deletion overlap");
  const state = f.settings().activeShare.download;
  assert.equal(state.observedHead, "h2");
  assert.equal(state.baseline.find((entry: any) => entry.path === "edit.md").sha256, sha("base"));
  assert.equal(state.reconciliation.length, 4);
  assert.equal(state.reconciliation.find((entry: any) => entry.path === "remote-delete.md").remote.op, "delete");
  onlyReads(f);
});

test("an edit made during reference download is preserved and never acknowledged", async (t) => {
  const f = fixture(t); f.remote({ "grocery.md": "base" }); await f.initialize();
  f.remote({ "grocery.md": "remote" }, "h2");
  f.hook(async (request) => { if (request.url.includes("/blob?")) f.write("grocery.md", "edited during download"); });
  await f.service().sync();
  assert.equal(f.read("grocery.md"), "edited during download");
  assert.equal(f.settings().activeShare.download.baseline[0].sha256, sha("base"));
  assert.equal(f.saved().activeShare.download.reconciliation[0].uploadBlocked, true);
});

test("remote deletion rechecks local bytes after journal persistence", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  f.remote({}, "h2");
  const stat = f.vault.adapter.stat;
  let calls = 0;
  f.vault.adapter.stat = async (path: string) => {
    if (path === "a.md" && ++calls === 3) f.write("a.md", "edit before removal");
    return stat(path);
  };
  await f.service().sync();
  assert.equal(f.read("a.md"), "edit before removal");
  assert.equal(f.settings().activeShare.download.reconciliation[0].remote.op, "delete");
});

test("head advancement retains blocked targets and baselines across restart and permission restoration", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base", "b.md": "base" }); await f.initialize();
  f.write("a.md", "offline edit"); f.capability("read");
  f.remote({ "a.md": "remote2", "b.md": "safe2" }, "h2"); await f.service().sync();
  await f.service().keepLocalReconciliation("a.md");
  f.restart(); f.capability("read-write");
  f.remote({ "a.md": "remote3", "b.md": "safe3" }, "h3"); await f.service().sync();
  const state = f.saved().activeShare.download;
  assert.equal(f.read("a.md"), "offline edit"); assert.equal(f.read("b.md"), "safe3");
  assert.equal(state.observedHead, "h3"); assert.equal(state.baseline.find((entry: any) => entry.path === "a.md").sha256, sha("base"));
  assert.equal(state.reconciliation[0].remoteHead, "h3"); assert.equal(state.reconciliation[0].remote.sha256, sha("remote3"));
  assert.equal(state.reconciliation[0].localChoice, "keep-local"); assert.equal(state.reconciliation[0].uploadBlocked, true);
  onlyReads(f);
});

test("interrupted disk application journals ambiguity and unaffected files continue after restart", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base", "b.md": "base" }); await f.initialize();
  const write = f.vault.adapter.writeBinary;
  f.vault.adapter.writeBinary = async (path: string, bytes: ArrayBuffer) => {
    await write(path, bytes);
    if (path === "a.md") throw new Error("synthetic interruption after disk write");
  };
  f.remote({ "a.md": "remote", "b.md": "safe update" }, "h2");
  await assert.rejects(f.service().sync(), /synthetic interruption/);
  assert.equal(f.saved().activeShare.download.applying.path, "a.md");
  assert.equal(f.saved().activeShare.download.baseline.find((entry: any) => entry.path === "a.md").sha256, sha("base"));
  f.vault.adapter.writeBinary = write; f.restart(); await f.service().sync();
  assert.equal(f.read("b.md"), "safe update");
  assert.match(f.saved().activeShare.download.reconciliation[0].reason, /Interrupted/);
  assert.equal(f.saved().activeShare.download.applying, undefined);
});

test("network failure preserves progress and reference retry succeeds without upload", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base", "b.md": "base" }); await f.initialize();
  f.remote({ "a.md": "next", "b.md": "next" }, "h2");
  f.hook(async (request) => { if (request.url.includes("/blob?") && request.url.includes("b.md")) throw new Error("connection interrupted"); });
  await assert.rejects(f.service().sync(), /connection interrupted/);
  assert.equal(f.read("a.md"), "next"); assert.equal(f.read("b.md"), "base");
  f.hook(); f.restart(); await f.service().sync(); assert.equal(f.read("b.md"), "next"); onlyReads(f);
});

test("inline checksum mismatch cannot overwrite or advance the baseline", async (t) => {
  const f = fixture(t); f.inline(); f.remote({ "a.md": "base" }); await f.initialize();
  const serve = responder;
  responder = async (request) => {
    const response = await serve(request);
    if (request.url.endsWith("/sync")) response.json.files[0].contentBase64 = Buffer.from("corrupt").toString("base64");
    return response;
  };
  f.remote({ "a.md": "remote" }, "h2");
  await assert.rejects(f.service().sync(), /checksum mismatch/);
  assert.equal(f.read("a.md"), "base"); assert.equal(f.saved().activeShare.download.baseline[0].sha256, sha("base"));
});

test("initial backup failure cannot touch local files and retry keeps old recovery copies", async (t) => {
  const f = fixture(t); f.write("a.md", "local"); f.remote({ "a.md": "remote" }); await f.service().stageShareSelection(id);
  const write = f.vault.adapter.writeBinary;
  f.vault.adapter.writeBinary = async () => { throw new Error("backup failed"); };
  await assert.rejects(f.service().initializeShareDownload(), /backup failed/);
  assert.equal(f.read("a.md"), "local"); assert.equal(f.settings().activeShare, undefined);
  const folder = f.saved().pendingShareSelection.download.initial.backupFolder;
  await assert.rejects(f.service().cancelShareSelection(), /Resume reconciliation/);
  f.vault.adapter.writeBinary = write; f.restart(); await f.service().initializeShareDownload();
  assert.notEqual(f.settings().activeShare.download.initial.backupFolder, folder);
  assert.equal(f.read("a.md"), "remote");
});

test("initial download preserves edits after backup and resumes after interruption", async (t) => {
  const f = fixture(t); f.write("a.md", "original"); f.remote({ "a.md": "remote", "b.md": "safe" });
  await f.service().stageShareSelection(id);
  f.hook(async (request) => {
    if (request.url.endsWith("/sync")) f.write("a.md", "after backup edit");
    if (request.url.includes("/blob?") && request.url.includes("b.md")) throw new Error("offline");
  });
  await assert.rejects(f.service().initializeShareDownload(), /offline/);
  assert.equal(f.read("a.md"), "after backup edit"); assert.equal(f.settings().activeShare, undefined);
  f.hook(); f.restart(); await f.service().initializeShareDownload();
  assert.equal(f.read("b.md"), "safe"); assert.equal(f.read("a.md"), "after backup edit");
  const state = f.saved().activeShare.download;
  assert.equal(f.read(`${state.initial.backupFolder}/a.md`), "original");
  assert.equal(state.reconciliation[0].uploadBlocked, true);
});

test("local-only remote choice backs up edits and follows the latest remote deletion", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  f.write("a.md", "local edit"); f.remote({ "a.md": "remote2" }, "h2"); f.capability("read"); await f.service().sync();
  f.remote({}, "h3"); await f.service().useRemoteReconciliation("a.md");
  assert.equal(f.read("a.md"), null); assert.equal(f.service().localReconciliations().length, 0);
  const backups = f.vault.getFiles().filter((file: any) => file.path.startsWith(".obsidian-git-sync/backups/") && file.path.endsWith("/a.md"));
  assert.ok(backups.some((file: any) => f.read(file.path) === "local edit")); onlyReads(f);
});

test("unknown folder state blocks only that file; ignored and InkVault sources stay untouched", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  f.remove("a.md"); mkdirSync(join(f.dir, "a.md"));
  f.write(".inkvault/source.json", "source"); f.write(".obsidian-git-sync/recovery", "private recovery");
  f.remote({ "a.md": "remote", "safe.md": "safe" }, "h2"); await f.service().sync();
  assert.equal(f.read("safe.md"), "safe"); assert.match(f.service().localReconciliations()[0].reason, /uncertain/);
  assert.equal(f.read(".inkvault/source.json"), "source"); assert.equal(f.read(".obsidian-git-sync/recovery"), "private recovery");
});

for (const status of [403, 404]) test(`share denial ${status} cannot fall back or discard recovery`, async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  const old = JSON.stringify(f.saved().activeShare.download); f.deny(status);
  await assert.rejects(f.service().sync(), (error: any) => error.status === status);
  assert.equal(JSON.stringify(f.saved().activeShare.download), old); onlyReads(f);
});

test("account/destination changes during download cannot apply returned bytes", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); f.remote({ "a.md": "remote" }, "h2");
  f.hook(async (request) => { if (request.url.includes("/blob?")) f.settings().userSlug = "liz"; });
  await assert.rejects(f.service().sync(), /destination or account changed/);
  assert.equal(f.read("a.md"), "base");
});

test("downgrade barriers persist before a failed read and survive restored permission", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  f.write("a.md", "offline edit"); f.capability("read");
  f.hook(async (request) => { if (request.url.endsWith("/sync")) throw new Error("read interrupted"); });
  await assert.rejects(f.service().sync(), /read interrupted/);
  assert.equal(f.saved().activeShare.capability, "read");
  assert.equal(f.saved().activeShare.download.reconciliation[0].uploadBlocked, true);
  f.restart(); f.hook(); f.capability("read-write"); await f.service().sync();
  assert.equal(f.read("a.md"), "offline edit"); assert.equal(f.saved().activeShare.download.reconciliation[0].uploadBlocked, true);
  onlyReads(f);
});

test("initial application restart retains completed files and deletions without false conflicts", async (t) => {
  const f = fixture(t); f.write("obsolete.md", "back me up");
  f.remote({ "a.md": "remote", "b.md": "later" });
  await f.service().stageShareSelection(id);
  const remove = f.vault.adapter.remove;
  f.vault.adapter.remove = async (path: string) => { await remove(path); throw new Error("interrupted deletion"); };
  await assert.rejects(f.service().initializeShareDownload(), /interrupted deletion/);
  assert.equal(f.read("a.md"), "remote"); assert.equal(f.read("obsolete.md"), null);
  f.vault.adapter.remove = remove; f.restart(); await f.service().initializeShareDownload();
  const state = f.saved().activeShare.download;
  assert.equal(state.reconciliation.length, 1, "Only the ambiguous deletion requires review");
  assert.equal(state.reconciliation[0].path, "obsolete.md"); assert.match(state.reconciliation[0].reason, /Interrupted/);
  assert.equal(f.read(`${state.initial.backupFolder}/obsolete.md`), "back me up");
});

test("blocked remote update becomes a durable tombstone on later head advancement", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); f.write("a.md", "local");
  f.remote({ "a.md": "remote" }, "h2"); await f.service().sync();
  f.restart(); f.remote({}, "h3"); await f.service().sync();
  const record = f.saved().activeShare.download.reconciliation[0];
  assert.equal(record.remote.op, "delete"); assert.equal(record.remoteHead, "h3");
  assert.equal(record.baseline.sha256, sha("base")); assert.equal(f.read("a.md"), "local");
});

test("reference binary checksum failure preserves bytes and baseline", async (t) => {
  const f = fixture(t); f.remote({ "a.bin": Buffer.from([0, 255, 17]) }); await f.initialize();
  const serve = responder;
  responder = async (request) => {
    const response = await serve(request);
    if (request.url.includes("/blob?")) response.arrayBuffer = Uint8Array.from([3, 4]).buffer;
    return response;
  };
  f.remote({ "a.bin": Buffer.from([128, 127, 1]) }, "h2");
  await assert.rejects(f.service().sync(), /checksum mismatch/);
  assert.deepEqual(readFileSync(join(f.dir, "a.bin")), Buffer.from([0, 255, 17]));
});

test("authentication configuration change blocks history and download without reinterpreting state", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  const serve = responder;
  responder = async (request) => request.url.endsWith("/auth/config") ? ok({ type: "oidc", issuer: "https://issuer.invalid" }) : serve(request);
  await assert.rejects(f.service().history("a.md"), /Authentication configuration changed/);
  await assert.rejects(f.service().sync(), /Authentication configuration changed/);
  assert.equal(f.read("a.md"), "base"); assert.equal(f.saved().activeShare.authentication, "password");
});

test("active state cannot be cancelled, retargeted or reset through legacy workflows", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  const old = JSON.stringify(f.saved().activeShare.download);
  await assert.rejects(f.service().stageShareSelection(id), /must be retained/);
  await f.service().cancelShareSelection(); // No pending selection: active ownership remains intact.
  assert.equal(JSON.stringify(f.saved().activeShare.download), old);
  assert.match(f.service().destinationBlocker(), /download mode/);
});

test("malformed or unsafe remote snapshots fail before any local application", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize();
  const serve = responder;
  for (const invalid of ["head", "path", "duplicate"]) {
    responder = async (request) => {
      const response = await serve(request);
      if (request.url.endsWith("/sync")) {
        if (invalid === "head") response.json.serverHead = null;
        if (invalid === "path") response.json.files.push({ path: "../escape.md", op: "delete" });
        if (invalid === "duplicate") response.json.files.push(response.json.files[0]);
      }
      return response;
    };
    f.remote({ "a.md": "remote" }, "h2");
    await assert.rejects(f.service().sync(), /Invalid|Unsafe|Duplicate/);
    assert.equal(f.read("a.md"), "base");
  }
});

test("writable selection requires explicit enablement and synchronizes exact Markdown/binary/deletion evidence", async (t) => {
  const f = fixture(t);
  f.remote({ "a.md": "base", "deleted.md": "base" }); await f.initialize();
  await f.service().enableShareWrites();
  f.write("a.md", "sent bytes"); f.write("attachment.bin", "binary bytes"); f.remove("deleted.md");
  await f.service().sync();
  assert.equal(String(f.remoteFiles()["a.md"]), "sent bytes");
  assert.equal(String(f.remoteFiles()["attachment.bin"]), "binary bytes");
  assert.equal(f.remoteFiles()["deleted.md"], undefined);
  assert.equal(f.settings().activeShare.download.baseline.find((entry: any) => entry.path === "a.md").sha256, sha("sent bytes"));
  assert.equal(f.settings().activeShare.download.writing, undefined);
  assert.ok(f.requests.every((request) => !/register|\/v1\/users\//.test(request.url)));
});

test("edits during chunk upload remain local and are never acknowledged by completion-time scanning", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.write("a.md", "captured");
  f.hook(async (request) => { if (request.url.endsWith("/chunk")) { f.write("a.md", "new unsent bytes"); f.hook(); } });
  await f.service().sync();
  assert.equal(String(f.remoteFiles()["a.md"]), "captured"); assert.equal(f.read("a.md"), "new unsent bytes");
  assert.equal(f.settings().activeShare.download.baseline.find((entry: any) => entry.path === "a.md").sha256, sha("captured"));
  assert.equal(f.settings().activeShare.download.reconciliation[0].uploadBlocked, true);
  await f.restart().sync(); assert.equal(String(f.remoteFiles()["a.md"]), "captured");
});

test("acknowledgement-lost retry recovers matching sent evidence across restart without resending uploads", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.write("a.md", "sent");
  f.after(async (request) => { if (JSON.parse(request.body).changes.length) { f.after(); throw new Error("lost acknowledgement"); } });
  await assert.rejects(f.service().sync(), /lost acknowledgement/);
  assert.equal(f.saved().activeShare.download.writing.stage, "submitted");
  const uploads = f.requests.filter((request) => request.url.endsWith("/uploads")).length;
  await f.restart().sync();
  assert.equal(f.requests.filter((request) => request.url.endsWith("/uploads")).length, uploads);
  assert.equal(f.settings().activeShare.download.writing, undefined);
  assert.equal(f.settings().activeShare.download.baseline[0].sha256, sha("sent"));
});

test("unknown write outcome blocks divergent remote contents instead of replaying after restart", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.write("a.md", "sent");
  f.after(async (request) => { if (JSON.parse(request.body).changes.length) { f.after(); throw new Error("lost acknowledgement"); } });
  await assert.rejects(f.service().sync());
  f.remote({ "a.md": "subsequent remote" }, "later");
  await f.restart().sync();
  assert.equal(f.read("a.md"), "sent"); assert.equal(String(f.remoteFiles()["a.md"]), "subsequent remote");
  assert.equal(f.settings().activeShare.download.reconciliation[0].uploadBlocked, true);
});

test("downgrade during staging stops writes; restart/restoration retain barriers until explicit reconciliation", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.write("a.md", "blocked edit");
  f.hook(async (request) => { if (request.url.endsWith("/chunk")) { f.capability("read"); f.hook(); } });
  await assert.rejects(f.service().sync(), /read-only/);
  assert.equal(String(f.remoteFiles()["a.md"]), "base");
  assert.equal(f.saved().activeShare.capability, "read");
  assert.equal(f.saved().activeShare.download.reconciliation[0].uploadBlocked, true);
  f.capability("read-write"); await f.restart().sync();
  assert.equal(String(f.remoteFiles()["a.md"]), "base");
  await f.service().uploadLocalReconciliation("a.md");
  assert.equal(String(f.remoteFiles()["a.md"]), "blocked edit");
  assert.equal(f.settings().activeShare.download.reconciliation.length, 0);
});

test("partial staging failure recovers conservatively, never acknowledges or automatically retries retained edits", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.write("a.md", "pending");
  f.hook(async (request) => { if (request.url.endsWith("/complete")) { f.hook(); throw new Error("staging interrupted"); } });
  await assert.rejects(f.service().sync(), /staging interrupted/);
  assert.equal(f.saved().activeShare.download.writing.stage, "staging");
  await f.restart().sync();
  assert.equal(f.read("a.md"), "pending"); assert.equal(String(f.remoteFiles()["a.md"]), "base");
  assert.equal(f.settings().activeShare.download.baseline[0].sha256, sha("base"));
  assert.equal(f.settings().activeShare.download.reconciliation[0].uploadBlocked, true);
});

test("explicit initial upload backs up local bytes, uses selected remote base and retains the original v1 state", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "remote", "remote-only.md": "remote" }); f.write("a.md", "local");
  await f.service().stageShareSelection(id);
  const legacy = JSON.stringify([f.settings().serverHead, f.settings().localManifest]);
  await f.service().initializeShareUpload();
  assert.equal(String(f.remoteFiles()["a.md"]), "local"); assert.equal(f.remoteFiles()["remote-only.md"], undefined);
  assert.equal(f.settings().activeShare.status, "writable");
  assert.equal(f.read(`${f.settings().activeShare.download.initial.backupFolder}/a.md`), "local");
  assert.equal(JSON.stringify([f.settings().serverHead, f.settings().localManifest]), legacy);
  const write = f.requests.find((request) => request.url.endsWith("/sync") && JSON.parse(request.body).changes.length);
  assert.equal(JSON.parse(write.body).baseHead, "h1");
});

test("interrupted file application is recovered before collecting writable changes", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  const state = f.settings().activeShare.download;
  state.applying = { path: "a.md", baseline: state.baseline[0], remote: { path: "a.md", op: "delete" },
    remoteHead: "h1", reason: "ambiguous disk write", uploadBlocked: true };
  f.write("a.md", "ambiguous local");
  await f.service().sync();
  assert.equal(String(f.remoteFiles()["a.md"]), "base"); assert.equal(f.read("a.md"), "ambiguous local");
  assert.match(state.reconciliation[0].reason, /Interrupted/);
  assert.equal(state.applying, undefined);
});

test("writable mode also guards edits made during download and continues unaffected files", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base", "safe.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.remote({ "a.md": "remote", "safe.md": "updated" }, "h2");
  f.hook(async (request) => { if (request.url.includes("/blob?path=a.md")) { f.write("a.md", "edit during download"); f.hook(); } });
  await f.service().sync();
  assert.equal(f.read("a.md"), "edit during download"); assert.equal(f.read("safe.md"), "updated");
  assert.equal(f.settings().activeShare.download.baseline.find((entry: any) => entry.path === "a.md").sha256, sha("base"));
  assert.equal(f.settings().activeShare.download.observedHead, "h2");
  assert.equal(f.settings().activeShare.download.reconciliation[0].uploadBlocked, true);
});

test("read-only selection cannot enable writes, reconcile by upload or mutate version metadata", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); f.capability("read"); await f.initialize();
  await assert.rejects(f.service().enableShareWrites(), /read-only/);
  await assert.rejects(f.service().uploadLocalReconciliation("a.md"), /Enable writable/);
  await assert.rejects(f.service().saveVersionMetadata({ path: "a.md", hash: "h1", name: "denied" }), /read-only/);
  assert.equal(f.service().canWriteSelectedShare(), false); onlyReads(f);
});

test("uncertain writable file fails closed per-file while safe remote updates continue", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base", "safe.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.remove("a.md"); mkdirSync(join(f.dir, "a.md"));
  f.remote({ "a.md": "changed", "safe.md": "updated" }, "h2");
  await f.service().sync(); assert.equal(f.read("safe.md"), "updated");
  assert.match(f.settings().activeShare.download.reconciliation[0].reason, /uncertain/);
  assert.equal(String(f.remoteFiles()["a.md"]), "changed");
});

test("a server conflict cleared elsewhere cannot make retained marker/local contents upload automatically", async (t) => {
  const f = fixture(t); f.remote({ "a.md": "base" }); await f.initialize(); await f.service().enableShareWrites();
  f.settings().activeShare.download.serverConflicts = [{ path: "a.md", reason: "server conflict" }];
  f.write("a.md", "retained unresolved contents");
  await f.service().sync();
  assert.equal(String(f.remoteFiles()["a.md"]), "base"); assert.equal(f.read("a.md"), "retained unresolved contents");
  assert.match(f.settings().activeShare.download.reconciliation[0].reason, /cleared elsewhere/);
  assert.equal(f.settings().activeShare.download.reconciliation[0].uploadBlocked, true);
});
