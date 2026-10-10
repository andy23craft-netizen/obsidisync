const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

module.exports = async ({ device, log, obsidian, offline, dataDir }) => {
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json"), "utf8"));
  const owner = accounts.accounts.find((account) => account.user === "dev");
  const reader = accounts.accounts.find((account) => account.user === "reader");
  const shares = [];
  for (const label of ["Private", "Household", "Third"]) {
    const share = await offline(["share", "create", `Synthetic writable ${label}`]);
    await offline(["membership", "grant", share.id, "local", owner.id, "read-write"]);
    const setup = path.join(path.dirname(dataDir), `writable-${share.id}.json`);
    fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
      authorName: "Synthetic Writable", authorEmail: "fixture@example.invalid" } }));
    await offline(["share", "setup", share.id, setup]); shares.push(share);
  }
  const remote = (index, file) => {
    const full = path.join(dataDir, "shares", shares[index].id, "repo", file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };
  const restart = (client) => {
    client.settings = JSON.parse(JSON.stringify(client.settings));
    client.service = new client.service.constructor(client.vault, client.settings, async () => {});
  };
  const setup = async (client, initialUpload = false) => {
    for (const [index, prefix] of ["Personal", "Harmony", "Third"].entries()) {
      await client.service.addCompositeMount(shares[index].id, prefix);
      const mount = client.settings.composite.mounts[index];
      if (initialUpload) {
        client.write(`${prefix}/same.md`, `base ${index}\n`);
        client.write(`${prefix}/delete.md`, "base delete\n");
        client.write(`${prefix}/attachment.bin`, Buffer.from([0, 255, index]));
        await client.service.initializeShareUpload(mount.mountId);
      } else {
        await client.service.initializeCompositeMount(mount.mountId);
        await client.service.enableShareWrites(mount.mountId);
      }
    }
  };
  const A = device("mounted-writer-A"), B = device("mounted-writer-B");
  log("W1. Explicit per-mount initial upload, writable selection and isolated Markdown/binary/deletion");
  await setup(A, true); await setup(B);
  A.write("Personal/same.md", "private update\n"); A.write("Harmony/same.md", "shared update\n");
  A.write("Harmony/attachment.bin", Buffer.from([255, 1, 0]));
  fs.rmSync(path.join(A.dir, "Personal/delete.md")); await A.service.sync(); await B.service.sync();
  assert.equal(remote(0, "same.md"), "private update\n"); assert.equal(remote(1, "same.md"), "shared update\n");
  assert.equal(B.read("Personal/delete.md"), null);
  assert.deepEqual(fs.readFileSync(path.join(B.dir, "Harmony/attachment.bin")), Buffer.from([255, 1, 0]));

  log("W2. Independent text and binary conflicts survive restart and resolve only in the named mount");
  A.write("Personal/same.md", "A private overlap\n"); B.write("Personal/same.md", "B private overlap\n");
  A.write("Harmony/attachment.bin", "A binary"); B.write("Harmony/attachment.bin", "B binary");
  await A.service.sync();
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["Personal/same.md", "Harmony/attachment.bin"]);
  assert.match(B.read("Personal/same.md"), /<<<<<<< server/); assert.equal(B.read("Harmony/attachment.bin"), "B binary");
  restart(B);
  const personal = () => B.settings.composite.mounts[0], harmony = () => B.settings.composite.mounts[1];
  await B.service.resolveConflicts([{ path: "same.md", kind: "text", content: "resolved private\n" }], personal().mountId);
  assert.equal(remote(0, "same.md"), "resolved private\n");
  assert.equal((await B.service.pendingConflicts(harmony().mountId))[0].path, "attachment.bin");
  await B.service.resolveConflicts([{ path: "attachment.bin", kind: "current" }], harmony().mountId);
  await A.service.sync(); assert.equal(A.read("Harmony/attachment.bin"), "B binary");

  log("W3. Remote deletion versus local edit remains an explicit per-mount conflict");
  fs.rmSync(path.join(A.dir, "Harmony/delete.md")); B.write("Harmony/delete.md", "local edit\n");
  await A.service.sync();
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["Harmony/delete.md"]);
  await B.service.resolveConflicts([{ path: "delete.md", kind: "delete" }], harmony().mountId);
  assert.equal(remote(1, "delete.md"), null); assert.equal(B.read("Harmony/delete.md"), null);

  const original = obsidian.requestUrl;
  const calls = [];
  try {
    log("W4. Partial staging interrupted by a move cannot leak private bytes; third mount continues");
    let moved = false;
    obsidian.requestUrl = async (request) => {
      calls.push(request.url); const response = await original(request);
      if (!moved && request.url.includes(shares[0].id) && request.url.endsWith("/chunk")) {
        moved = true;
        fs.renameSync(path.join(B.dir, "Personal/same.md"), path.join(B.dir, "Harmony/moved.md"));
        await B.service.observeCompositeRename("Personal/same.md", "Harmony/moved.md");
      }
      return response;
    };
    B.write("Personal/same.md", "private staged only\n"); B.write("Third/same.md", "unaffected third\n");
    await assert.rejects(B.service.sync(), /stale/);
    assert.equal(remote(0, "same.md"), "resolved private\n"); assert.equal(remote(1, "moved.md"), null);
    assert.equal(remote(2, "same.md"), "unaffected third\n");
    obsidian.requestUrl = original; restart(B); await B.service.sync();
    assert.ok(personal().barriers.length); assert.ok(harmony().barriers.length);
    const move = B.settings.composite.moves[0];
    await B.service.reconcileCompositeMove(harmony().mountId, move.id, "moved.md", "keep-local");
    await B.service.reconcileCompositeMove(personal().mountId, move.id, "same.md", "use-remote");
    await B.service.sync(); assert.equal(remote(1, "moved.md"), null);

    log("W5. A committed submission followed by a move cannot acknowledge; restart recovers only captured bytes");
    moved = false;
    obsidian.requestUrl = async (request) => {
      calls.push(request.url); const response = await original(request);
      if (!moved && request.url.includes(shares[0].id) && request.url.endsWith("/sync") && JSON.parse(request.body).changes.length) {
        moved = true;
        fs.renameSync(path.join(B.dir, "Personal/same.md"), path.join(B.dir, "Harmony/committed-move.md"));
        await B.service.observeCompositeRename("Personal/same.md", "Harmony/committed-move.md");
        throw new Error("synthetic lost committed response");
      }
      return response;
    };
    B.write("Personal/same.md", "captured committed version\n");
    await assert.rejects(B.service.sync(), /lost committed/);
    assert.equal(personal().download.writing.stage, "submitted");
    assert.notEqual(personal().download.baseline.find((file) => file.path === "same.md").sha256, sha("captured committed version\n"));
    const uploads = calls.filter((url) => url.endsWith("/uploads")).length;
    obsidian.requestUrl = original; restart(B); await B.service.sync();
    assert.equal(calls.filter((url) => url.endsWith("/uploads")).length, uploads);
    assert.equal(personal().download.baseline.find((file) => file.path === "same.md").sha256, sha("captured committed version\n"));
    assert.ok(personal().barriers.length); assert.ok(harmony().barriers.length);
    assert.equal(remote(0, "same.md"), "captured committed version\n"); assert.equal(remote(1, "committed-move.md"), null);

    log("W6. Real membership downgrade during staging preserves edits; restored access cannot auto-upload");
    const C = device("mounted-writer-C"); await setup(C);
    let downgraded = false;
    obsidian.requestUrl = async (request) => {
      const response = await original(request);
      if (!downgraded && request.url.includes(shares[0].id) && request.url.endsWith("/uploads")) {
        downgraded = true; await offline(["membership", "grant", shares[0].id, "local", owner.id, "read"]);
      }
      return response;
    };
    C.write("Personal/same.md", "blocked by membership\n"); C.write("Third/same.md", "third survives downgrade\n");
    await assert.rejects(C.service.sync(), /read-only/);
    assert.equal(remote(0, "same.md"), "captured committed version\n"); assert.equal(remote(2, "same.md"), "third survives downgrade\n");
    obsidian.requestUrl = original;
    await offline(["membership", "grant", shares[0].id, "local", owner.id, "read-write"]);
    restart(C); await C.service.sync(); assert.equal(remote(0, "same.md"), "captured committed version\n");
    await C.service.uploadLocalReconciliation("same.md", C.settings.composite.mounts[0].mountId);
    assert.equal(remote(0, "same.md"), "blocked by membership\n");

    log("W7. Initial replacement uses a real base; concurrent changes produce recoverable conflicts");
    const D = device("mounted-initial-concurrency"); await D.service.addCompositeMount(shares[0].id, "Personal");
    D.write("Personal/same.md", "initial replacement\n");
    let advanced = false;
    obsidian.requestUrl = async (request) => {
      const response = await original(request);
      if (!advanced && request.url.includes(shares[0].id) && request.url.endsWith("/uploads")) {
        advanced = true; C.write("Personal/same.md", "concurrent remote edit\n"); await C.service.sync();
      }
      return response;
    };
    await assert.rejects(D.service.initializeShareUpload(D.settings.composite.mounts[0].mountId), /server conflicts/);
    assert.equal(remote(0, "same.md"), "concurrent remote edit\n");
    assert.match(D.read("Personal/same.md"), /<<<<<<< server/);
    assert.ok(D.settings.composite.mounts[0].download.initial.backupManifest.length);
    obsidian.requestUrl = original;

    log("W8. Inaccessible share reads and mutations remain indistinguishable from nonexistent shares");
    const readerClient = device("mounted-denied-reader", { userSlug: "reader" });
    // Obtain a real reader session without granting membership in any of these shares.
    const login = await fetch(`${C.settings.serverUrl}/v1/auth/password/login`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ username: reader.user, password: "synthetic-harness-password-123" }) });
    const session = await login.json();
    const headers = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
    for (const [suffix, method, body] of [["sync-state", "GET"], ["conflicts?clientId=denied", "GET"],
      ["sync", "POST", { baseHead: null, clientId: "denied", deviceName: "denied", changes: [], clientManifest: [] }],
      ["uploads", "POST", { path: "same.md", sha256: sha("private"), size: 7 }]]) {
      const responses = [];
      for (const id of [shares[0].id, "s_ffffffffffffffffffffffffffffffff"]) {
        const response = await fetch(`${readerClient.settings.serverUrl}/v2/shares/${id}/${suffix}`, {
          method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        responses.push([response.status, await response.text()]);
      }
      assert.equal(responses[0][0], 404); assert.deepEqual(responses[0], responses[1]);
    }
  } finally { obsidian.requestUrl = original; }
  assert.ok(calls.every((url) => !url.includes("/v1/users/") && !url.includes("/register")));
  log("FEAT-11 real-server writable mounts passed (8 stages). Synthetic disposable data only.");
};
