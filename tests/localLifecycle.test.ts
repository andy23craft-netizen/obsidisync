import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const Module = require("node:module"), originalLoad = Module._load;
const mock = require(join(process.cwd(), "tests/e2e/obsidian-mock.js"));
Module._load = function(name: string, ...rest: any[]) { return name === "obsidian" ? mock : originalLoad.call(this, name, ...rest); };
const { LocalLifecycle, validateLifecycle, lifecycleBlocker } = require("../src/localLifecycle");
const { GitService } = require("../src/gitService");
const { DEFAULT_SETTINGS } = require("../src/settings");
Module._load = originalLoad;
(globalThis as any).crypto ??= webcrypto;
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const shareId = "s_" + "1".repeat(32);
const mount = (id = "target", prefix = "Personal", share = shareId) => ({
  shareId: share, label: "Private", capability: "read-write", serverUrl: "http://localhost:8787",
  identity: { serverUrl: "http://localhost:8787", user: "andy", subject: "p_andy" }, authentication: "password",
  mountId: id, localPrefix: prefix, moveGeneration: 0, initialized: false, status: "download-only", barriers: [],
  download: { observedHead: null, baseline: [], reconciliation: [], initial: { backupFolder: "", appliedPaths: [], complete: false } }
});
const proposed = () => ({ version: 1, revision: 1, mounts: [mount()], moves: [] });

function fixture(t: any) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-tests", "lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = new mock.Vault(join(root, "vault"));
  let settings: any = { ...clone(DEFAULT_SETTINGS), serverUrl: "http://localhost:8787", userSlug: "andy", vaultSlug: "old",
    oidcAccessToken: "synthetic-local-secret", authenticatedIdentity: mount().identity, initialSyncDone: true,
    serverHead: "original-head", localManifest: [] };
  let durable = clone(settings);
  let saves = 0, fault = 0, afterSave = false;
  const persist = async (next: any) => {
    saves++;
    if (saves === fault && !afterSave) throw new Error("save interrupted");
    durable = clone(next);
    if (saves === fault && afterSave) throw new Error("save interrupted after commit");
  };
  let lifecycle = new LocalLifecycle(vault, settings, persist);
  const write = (path: string, bytes: string | Uint8Array) => {
    mkdirSync(dirname(join(vault.root, path)), { recursive: true }); writeFileSync(join(vault.root, path), bytes);
  };
  write("note.md", "original"); write("image.bin", new Uint8Array([0, 255, 1]));
  write("local.md", "excluded"); write(".obsidian/workspace.json", "config");
  const restart = () => { settings = clone(durable); validateLifecycle(settings); lifecycle = new LocalLifecycle(vault, settings, persist); return lifecycle; };
  const plan = async () => {
    const mappings = await lifecycle.preview(proposed(), [{ source: "note.md", destination: "Personal/note.md" },
      { source: "image.bin", destination: "Personal/image.bin" }]);
    await lifecycle.plan(proposed(), mappings);
  };
  return { root, vault, write, plan, persist, restart, get lifecycle() { return lifecycle; }, get settings() { return settings; },
    get durable() { return durable; }, get saves() { return saves; },
    fault: (at: number, after = false) => { fault = at; afterSave = after; },
    exists: (path: string) => existsSync(join(vault.root, path)),
    read: (path: string) => readFileSync(join(vault.root, path)),
    mutateDurable: (work: (value: any) => void) => work(durable) };
}

test("conversion verifies credential-bearing settings and bytes, gates original binding, then activates fresh state", async (t) => {
  const f = fixture(t); await f.plan();
  assert.match(lifecycleBlocker(f.settings), /recovery/);
  const journal = f.settings.conversion;
  assert.equal(JSON.parse(f.read(journal.settingsBackup).toString()).oidcAccessToken, "synthetic-local-secret");
  assert.equal(f.read(`${journal.backupFolder}/files/note.md`).toString(), "original");
  await f.restart().activate();
  assert.equal(f.exists("note.md"), false); assert.equal(f.read("Personal/note.md").toString(), "original");
  assert.deepEqual([...f.read("Personal/image.bin")], [0, 255, 1]);
  assert.equal(f.read("local.md").toString(), "excluded");
  assert.equal(f.read(".obsidian/workspace.json").toString(), "config");
  assert.equal(f.settings.conversion.phase, "activated"); assert.equal(f.settings.conversionGate, undefined);
  assert.equal(f.settings.composite.mounts[0].initialized, false);
  assert.deepEqual(f.settings.composite.mounts[0].download.baseline, []);
  assert.equal(f.settings.composite.mounts[0].status, "download-only");
  await assert.rejects(f.lifecycle.reverse(), /No pre-activation/);
});

for (const after of [false, true]) test(`every conversion save interruption recovers from disk (after commit=${after})`, async (t) => {
  const reference = fixture(t); await reference.plan(); await reference.lifecycle.activate();
  const count = reference.saves;
  for (let at = 1; at <= count; at++) {
    const f = fixture(t); f.fault(at, after);
    try { await f.plan(); await f.lifecycle.activate(); assert.fail(`save ${at} must fail`); }
    catch (error) { assert.match(String(error), /save interrupted/); }
    f.fault(0); f.restart();
    if (f.settings.conversionGate) await f.lifecycle.activate();
    else if (f.settings.conversion?.phase !== "activated") { assert.equal(f.exists("note.md"), true); await f.plan(); await f.lifecycle.activate(); }
    assert.equal(f.settings.conversion.phase, "activated");
    assert.equal(f.read("Personal/note.md").toString(), "original");
    assert.equal(f.exists("note.md"), false);
  }
});

for (const operation of ["writeBinary", "remove", "mkdir", "readBinary", "stat", "exists", "list"]) for (const after of [false, true]) {
  test(`adapter ${operation} interruption (after=${after}) retains recoverable original bytes`, async (t) => {
    // Discover all adapter boundaries in a complete conversion, including backup creation.
    const reference = fixture(t); let total = 0;
    const original = reference.vault.adapter[operation].bind(reference.vault.adapter);
    reference.vault.adapter[operation] = async (...args: any[]) => { total++; return original(...args); };
    await reference.plan(); await reference.lifecycle.activate();
    for (let at = 1; at <= total; at++) {
      const f = fixture(t), original = f.vault.adapter[operation].bind(f.vault.adapter);
      let calls = 0;
      f.vault.adapter[operation] = async (...args: any[]) => {
        calls++;
        if (calls === at && !after) throw new Error("adapter interrupted");
        const result = await original(...args);
        if (calls === at && after) throw new Error("adapter interrupted");
        return result;
      };
      await assert.rejects(async () => { await f.plan(); await f.lifecycle.activate(); }, /adapter interrupted/);
      f.vault.adapter[operation] = original; f.restart();
      if (f.settings.conversionGate) await f.lifecycle.activate();
      else if (f.settings.conversion?.phase !== "activated") {
        assert.equal(f.read("note.md").toString(), "original");
        // A failed pre-journal backup is retained; a new attempt always uses a fresh folder.
        await f.plan(); await f.lifecycle.activate();
      }
      assert.equal(f.read("Personal/note.md").toString(), "original");
    }
  });
}

test("reversal is restartable and retains changed files and corrupt backup evidence", async (t) => {
  const f = fixture(t); await f.plan(); await f.lifecycle.resume();
  f.fault(f.saves + 2, true); await assert.rejects(f.lifecycle.reverse(), /save interrupted/);
  f.fault(0); await f.restart().reverse();
  assert.equal(f.read("note.md").toString(), "original"); assert.equal(f.exists("Personal/note.md"), false);
  assert.equal(f.settings.serverHead, "original-head"); assert.equal(f.settings.conversion.phase, "reversed");
  const changed = fixture(t); await changed.plan(); await changed.lifecycle.resume();
  changed.write("Personal/note.md", "intervening edit");
  await assert.rejects(changed.restart().reverse(), /Changed destination/);
  assert.equal(changed.read("Personal/note.md").toString(), "intervening edit");
  const corrupt = fixture(t); await corrupt.plan();
  corrupt.write(`${corrupt.settings.conversion.backupFolder}/files/note.md`, "damaged");
  await assert.rejects(corrupt.restart().activate(), /backup mismatch/);
  assert.equal(corrupt.read("note.md").toString(), "original");
});

test("preview, hashes, aliases, symlinks, missing bytes and excluded changes fail closed", async (t) => {
  for (const destination of ["local.md", "LOCAL.md", "../outside", ".obsidian/note.md"]) {
    const f = fixture(t);
    await assert.rejects(f.lifecycle.preview(proposed(), [{ source: "note.md", destination }]));
  }
  const f = fixture(t); await f.plan(); f.write("note.md", "changed");
  await assert.rejects(f.restart().activate(), /uncertain/); assert.equal(f.read("note.md").toString(), "changed");
  const excluded = fixture(t); await excluded.plan(); excluded.write("local.md", "new local");
  await assert.rejects(excluded.lifecycle.activate(), /Excluded file changed/);
  const link = fixture(t); symlinkSync(join(link.vault.root, "local.md"), join(link.vault.root, "alias.md"));
  await assert.rejects(link.lifecycle.preview(proposed(), [{ source: "alias.md", destination: "Personal/alias.md" }]), /Symlink/);
  const missing = fixture(t); await missing.plan(); rmSync(join(missing.vault.root, "note.md"));
  await assert.rejects(missing.lifecycle.activate(), /uncertain/);
});

test("corrupt/missing gate journals cannot route to legacy synchronization", async (t) => {
  const f = fixture(t); await f.plan();
  for (const mutate of [(s: any) => { delete s.conversion; }, (s: any) => { s.conversion.version = 8; },
    (s: any) => { s.conversionGate = "wrong"; }, (s: any) => { s.conversion.mappings[0].sha256 = "bad"; }]) {
    const settings = clone(f.settings); mutate(settings); assert.throws(() => lifecycleBlocker(settings));
  }
});

test("inaccessible detachment atomically archives journals, preserves files and siblings, and blocks fallback", async (t) => {
  const f = fixture(t);
  const first = mount("lost"), sibling = mount("sibling", "Harmony", "s_" + "2".repeat(32));
  (first.download as any).writing = { stage: "submitted", entries: [] };
  f.settings.composite = { version: 1, revision: 2, mounts: [first, sibling], moves: [] };
  const siblingBefore = clone(sibling);
  await f.lifecycle.detach("lost");
  assert.deepEqual(f.settings.composite.mounts, [siblingBefore]);
  assert.equal(f.settings.bindingArchives.entries[0].original.composite.mounts[0].download.writing.stage, "submitted");
  assert.equal(f.read("note.md").toString(), "original");
  await f.restart().detach("sibling"); assert.equal(f.settings.composite.mounts.length, 0);
  const single = fixture(t); await single.lifecycle.detach();
  assert.match(lifecycleBlocker(single.settings), /detached/);
  assert.equal(single.settings.serverHead, "original-head");
  await single.restart().plan(proposed(), []); await single.lifecycle.activate();
  assert.equal(single.settings.composite.mounts[0].initialized, false);
  assert.equal(single.settings.bindingArchives.entries.length, 1);
});

for (const after of [false, true]) test(`failed archival save (after=${after}) blocks engines until reload`, async (t) => {
  const f = fixture(t); f.fault(1, after);
  const service = new GitService(f.vault, f.settings, async () => {}, undefined, undefined, f.persist);
  await assert.rejects(service.detachBinding(), /save interrupted/);
  assert.equal(f.settings.disabledBinding, undefined); assert.equal(f.exists("note.md"), true);
  await assert.rejects(service.sync(), /uncertain/);
  await assert.rejects(service.detachBinding(), /Reload/);
  f.fault(0); f.restart();
  if (!after) await f.lifecycle.detach();
  assert.ok(f.settings.disabledBinding);
});

for (const operation of ["writeBinary", "remove", "mkdir"]) for (const after of [false, true]) {
  test(`reversal adapter ${operation} interruption (after=${after}) is recoverable`, async (t) => {
    const reference = fixture(t); await reference.plan(); await reference.lifecycle.resume();
    let total = 0; const original = reference.vault.adapter[operation].bind(reference.vault.adapter);
    reference.vault.adapter[operation] = async (...args: any[]) => { total++; return original(...args); };
    await reference.lifecycle.reverse();
    for (let at = 1; at <= total; at++) {
      const f = fixture(t); await f.plan(); await f.lifecycle.resume();
      let calls = 0; const original = f.vault.adapter[operation].bind(f.vault.adapter);
      f.vault.adapter[operation] = async (...args: any[]) => {
        calls++; if (calls === at && !after) throw new Error("adapter interrupted");
        const result = await original(...args);
        if (calls === at && after) throw new Error("adapter interrupted"); return result;
      };
      await assert.rejects(f.lifecycle.reverse(), /adapter interrupted/);
      f.vault.adapter[operation] = original; await f.restart().reverse();
      assert.equal(f.read("note.md").toString(), "original"); assert.equal(f.exists("Personal/note.md"), false);
    }
  });
}

for (const after of [false, true]) test(`every reversal save is restartable (after=${after})`, async (t) => {
  const reference = fixture(t); await reference.plan(); await reference.lifecycle.resume();
  const before = reference.saves; await reference.lifecycle.reverse();
  for (let offset = 1; offset <= reference.saves - before; offset++) {
    const f = fixture(t); await f.plan(); await f.lifecycle.resume(); f.fault(f.saves + offset, after);
    await assert.rejects(f.lifecycle.reverse(), /save interrupted/);
    f.fault(0); f.restart(); if (f.settings.conversionGate) await f.lifecycle.reverse();
    assert.equal(f.settings.conversion.phase, "reversed"); assert.equal(f.read("note.md").toString(), "original");
    assert.equal(f.exists("Personal/note.md"), false);
  }
});

test("gated recovery rejects changed configuration and contradictory activation evidence", async (t) => {
  const f = fixture(t); await f.plan(); f.settings.serverUrl = "http://localhost:9001";
  await assert.rejects(f.lifecycle.activate(), /configuration changed/);
  assert.equal(f.read("note.md").toString(), "original");
  await f.restart().activate();
  for (const mutate of [(s: any) => { delete s.conversionActivation; }, (s: any) => { delete s.composite; },
    (s: any) => { s.conversionGate = s.conversion.id; }, (s: any) => { s.conversion.activationRevision = 999; },
    (s: any) => { s.conversion.proposed.mounts[0].download.baseline = [{ path: "secret.md" }]; }]) {
    const settings = clone(f.settings); mutate(settings); assert.throws(() => validateLifecycle(settings));
  }
});
