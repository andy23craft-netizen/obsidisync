const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async ({ device, log, obsidian, offline, dataDir, readerToken }) => {
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json"), "utf8"));
  const owner = accounts.accounts.find((entry) => entry.user === "dev");
  const reader = accounts.accounts.find((entry) => entry.user === "reader");
  const shares = [];
  for (const label of ["Private", "Household"]) {
    const share = await offline(["share", "create", `Synthetic import ${label}`]);
    await offline(["membership", "grant", share.id, "local", owner.id, "read-write"]);
    if (label === "Household") await offline(["membership", "grant", share.id, "local", reader.id, "read"]);
    const setup = path.join(path.dirname(dataDir), `import-${share.id}.json`);
    fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
      authorName: "Synthetic Import", authorEmail: "fixture@example.invalid" } }));
    await offline(["share", "setup", share.id, setup]); shares.push(share);
  }
  const A = device("import-owner"), B = device("import-competitor");
  for (const client of [A, B]) for (const [index, prefix] of ["Personal", "Harmony"].entries()) {
    await client.service.addCompositeMount(shares[index].id, prefix);
    const mount = client.settings.composite.mounts[index];
    await client.service.initializeCompositeMount(mount.mountId); await client.service.enableShareWrites(mount.mountId);
  }
  const remote = (index, file) => {
    const full = path.join(dataDir, "shares", shares[index].id, "repo", file);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  };
  const restart = (client) => {
    client.settings = JSON.parse(fs.readFileSync(client.settingsPath, "utf8"));
    client.service = new client.service.constructor(client.vault, client.settings, async () => client.persist(client.settings));
  };
  A.write("Personal/note.md", "[[private.md]] ![[attachment.bin]]\n");
  A.write("Personal/private.md", "private note\n"); A.write("Personal/attachment.bin", Buffer.from([0, 255, 7]));
  await A.service.sync(); await B.service.sync();
  const original = obsidian.requestUrl;
  log("I1. Explicit private-to-household import preserves selected text/binary bytes and separates deletion consent");
  const preview = await A.service.previewImport([
    { source: "Personal/note.md", destination: "Harmony/imported.md" },
    { source: "Personal/attachment.bin", destination: "Harmony/attachment.bin" }
  ]);
  await A.service.approveImport(preview);
  assert.equal(remote(0, "note.md").toString(), "[[private.md]] ![[attachment.bin]]\n");
  assert.equal(remote(1, "private.md"), null);
  await B.service.sync();
  assert.deepEqual(fs.readFileSync(path.join(B.dir, "Harmony/attachment.bin")), Buffer.from([0, 255, 7]));
  const readerDevice = device("import-reader", { oidcAccessToken: readerToken, userSlug: "reader" });
  assert.ok(!(await readerDevice.service.discoverShares()).some((share) => share.shareId === shares[0].id));
  await assert.rejects(readerDevice.service.addCompositeMount(shares[0].id, "Private"), /unavailable|inaccessible/);
  await readerDevice.service.addCompositeMount(shares[1].id, "Shared");
  await readerDevice.service.initializeCompositeMount(readerDevice.settings.composite.mounts[0].mountId);
  assert.equal(readerDevice.read("Shared/imported.md"), "[[private.md]] ![[attachment.bin]]\n");
  assert.equal(readerDevice.read("Shared/private.md"), null);
  await A.service.deleteImportSources(preview.id);
  assert.equal(remote(0, "note.md"), null); assert.equal(remote(0, "attachment.bin"), null);
  assert.equal(remote(0, "private.md").toString(), "private note\n");

  log("I2. Competing real-server creation returns 412 without merge or source deletion");
  const collision = await A.service.previewImport([{ source: "Personal/private.md", destination: "Harmony/race.md" }]);
  let raced = false;
  try {
    obsidian.requestUrl = async (request) => {
      const body = request.body ? JSON.parse(request.body) : {};
      if (!raced && body.destinationCondition) {
        raced = true; B.write("Harmony/race.md", "competitor\n"); await B.service.sync();
      }
      return original(request);
    };
    await assert.rejects(A.service.approveImport(collision), (error) => error.status === 412);
  } finally { obsidian.requestUrl = original; }
  assert.equal(remote(1, "race.md").toString(), "competitor\n");
  assert.equal(remote(0, "private.md").toString(), "private note\n");
  await assert.rejects(A.service.resumeImport(collision.id), /rejected/);
  const recaptured = await A.service.previewImport([{ source: "Personal/private.md", destination: "Harmony/recaptured.md" }], undefined, collision.id);
  await A.service.approveImport(recaptured);
  assert.equal(remote(1, "recaptured.md").toString(), "private note\n");
  assert.ok(A.service.hasLocalBarrier("Harmony/race.md"));

  log("I3. Lost conditional response and lost source-deletion response recover from captured evidence without replay");
  A.write("Personal/lost.md", "captured\n"); await A.service.sync();
  const lost = await A.service.previewImport([{ source: "Personal/lost.md", destination: "Harmony/lost.md" }]);
  let uploads = 0;
  try {
    obsidian.requestUrl = async (request) => {
      if (request.url.endsWith("/uploads")) uploads++;
      const response = await original(request);
      if (request.body && JSON.parse(request.body).destinationCondition) throw new Error("synthetic lost acceptance");
      return response;
    };
    await assert.rejects(A.service.approveImport(lost), /lost acceptance/);
  } finally { obsidian.requestUrl = original; }
  assert.equal(uploads, 1); restart(A); await A.service.resumeImport(lost.id);
  assert.equal(A.read("Personal/lost.md"), "captured\n");
  try {
    obsidian.requestUrl = async (request) => {
      const response = await original(request);
      if (request.url.includes(shares[0].id) && request.body && JSON.parse(request.body).changes?.some((file) => file.op === "delete")) {
        throw new Error("synthetic lost deletion");
      }
      return response;
    };
    await assert.rejects(A.service.deleteImportSources(lost.id), /lost deletion/);
  } finally { obsidian.requestUrl = original; }
  restart(A); await A.service.deleteImportSources(lost.id);
  assert.ok(A.service.importRecords().find((record) => record.id === lost.id).files[0].deleted);
  assert.equal(remote(0, "lost.md"), null); assert.equal(remote(1, "lost.md").toString(), "captured\n");
  log("I4. Reader cannot import into a read-only destination; private bytes remain isolated");
  readerDevice.write("Local/note.md", "reader-local\n");
  await assert.rejects(readerDevice.service.previewImport([{ source: "Local/note.md", destination: "Shared/denied.md" }]), /Writable|read-only/);
  assert.equal(remote(1, "denied.md"), null);
  log("I5. Concurrent remote source edits conflict with deletion and retain both remote bytes and local recovery");
  A.write("Personal/concurrent.md", "captured original\n"); await A.service.sync(); await B.service.sync();
  const concurrent = await A.service.previewImport([{ source: "Personal/concurrent.md", destination: "Harmony/concurrent.md" }]);
  await A.service.approveImport(concurrent);
  let edited = false;
  try {
    obsidian.requestUrl = async (request) => {
      const body = request.body ? JSON.parse(request.body) : {};
      if (!edited && request.url.includes(shares[0].id) && body.changes?.some((file) => file.op === "delete")) {
        edited = true; B.write("Personal/concurrent.md", "new remote source\n"); await B.service.sync();
      }
      return original(request);
    };
    await assert.rejects(A.service.deleteImportSources(concurrent.id), /conflict|unconfirmed/i);
  } finally { obsidian.requestUrl = original; }
  assert.equal(remote(0, "concurrent.md").toString(), "new remote source\n");
  assert.equal(remote(1, "concurrent.md").toString(), "captured original\n");
  const evidence = A.service.importRecords().find((record) => record.id === concurrent.id).files[0];
  assert.equal(A.read(`${evidence.backupFolder}/Personal/concurrent.md`), "captured original\n");
  assert.ok(!evidence.deleted);
  log("FEAT-14 real-server import scenario passed (5 stages). Synthetic disposable data only.");
};
