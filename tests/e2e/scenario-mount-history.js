const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async ({ device, log, shareId, offline, dataDir, obsidian }) => {
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json"), "utf8"));
  const owner = accounts.accounts.find(account => account.user === "dev");
  const privateShare = await offline(["share", "create", "Synthetic history private"]);
  await offline(["membership", "grant", privateShare.id, "local", owner.id, "read-write"]);
  const setup = path.join(path.dirname(dataDir), "history-private-setup.json");
  fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
    authorName: "Synthetic history", authorEmail: "fixture@example.invalid" } }));
  await offline(["share", "setup", privateShare.id, setup]);
  const seedPrivate = device("history-private-seed"), seedShared = device("history-shared-seed");
  seedPrivate.write("same.md", "private first\n"); seedPrivate.write("same.bin", Buffer.from([0, 255, 1]));
  await seedPrivate.service.stageShareSelection(privateShare.id); await seedPrivate.service.initializeShareUpload();
  seedShared.write("same.md", "shared first\n"); seedShared.write("same.bin", Buffer.from([0, 255, 2]));
  await seedShared.service.sync();
  const client = device("history-composite");
  await client.service.addCompositeMount(privateShare.id, "Personal");
  await client.service.addCompositeMount(shareId, "Harmony");
  const personal = client.settings.composite.mounts[0], harmony = client.settings.composite.mounts[1];
  for (const mount of [personal, harmony]) await client.service.initializeCompositeMount(mount.mountId);
  await client.service.enableShareWrites(personal.mountId);

  log("H1. Equal filenames use isolated history, pinned text/binary bytes and device/version metadata");
  const originalPrivate = await client.service.history("Personal/same.md");
  const originalShared = await client.service.history("Harmony/same.md");
  const privateHash = originalPrivate[0].hash, sharedHash = originalShared[0].hash;
  assert.equal(Buffer.from(await client.service.blobAtVersion("Personal/same.bin", privateHash)).compare(Buffer.from([0, 255, 1])), 0);
  assert.equal(Buffer.from(await client.service.blobAtVersion("Harmony/same.bin", sharedHash)).compare(Buffer.from([0, 255, 2])), 0);
  assert.equal(Buffer.from((await client.service.fileAtVersion("Personal/same.md", privateHash)).contentBase64, "base64").toString(), "private first\n");
  assert.equal(Buffer.from((await client.service.fileAtVersion("Harmony/same.md", sharedHash)).contentBase64, "base64").toString(), "shared first\n");
  assert.ok((await client.service.devices(personal.mountId)).length);
  assert.ok((await client.service.deviceVersions("Personal/same.md")).length);
  await client.service.saveVersionMetadata({ path: "Personal/same.md", hash: privateHash, name: "Private named revision" });
  assert.equal((await client.service.history("Personal/same.md"))[0].name, "Private named revision");
  assert.notEqual((await client.service.history("Harmony/same.md"))[0].name, "Private named revision");
  await assert.rejects(client.service.saveVersionMetadata({ path: "Harmony/same.md", hash: sharedHash, name: "denied" }), /read-only/);
  assert.deepEqual(await client.service.history("outside.md"), []);

  log("H2. Historical restoration preserves newer local bytes, leaves barriers and never uploads");
  client.write("Personal/same.md", "newer retained private edit\n");
  const sibling = JSON.stringify(harmony);
  await client.service.restoreHistoricalFile("Personal/same.md", privateHash);
  assert.equal(client.read("Personal/same.md"), "private first\n");
  const record = personal.download.reconciliation.find(record => record.path === "same.md");
  assert.equal(client.read(`${record.backupFolder}/Personal/same.md`), "newer retained private edit\n");
  assert.equal(record.uploadBlocked, true); assert.equal(JSON.stringify(harmony), sibling);
  const stale = client.service.fileContext("Personal/same.md");
  await client.service.observeCompositeRename("Personal/absent.md", "outside.md");
  await assert.rejects(client.service.saveVersionMetadata({ path: "Personal/same.md", hash: privateHash, name: "stale" }, stale), /stale/);

  log("H3. Explicit mount grant inventories remain separate from original-namespace legacy grants");
  const legacy = await client.service.createDevicePassword("Synthetic original namespace", "Tablet");
  const native = await client.service.createShareCredential("Synthetic private DAV", "Tablet", "read", personal.mountId);
  assert.equal(native.shareId, privateShare.id); assert.equal(native.username, privateShare.id); assert.equal(native.lifecycle, "staged");
  assert.equal((await client.service.shareCredentialInventory(personal.mountId)).entries.length, 1);
  assert.equal((await client.service.shareCredentialInventory(harmony.mountId)).entries.length, 0);
  assert.ok((await client.service.legacyCredentialInventory()).entries.some(entry => entry.id === legacy.id));
  assert.ok(!JSON.stringify(client.settings).includes(native.password));
  await offline(["credential", "share", "activate", native.id]);
  const credentialStore = path.join(dataDir, "auth/share-device-passwords.json");
  const credentialBytes = fs.readFileSync(credentialStore);

  log("H4. Denied history/blob/device/metadata cannot fall back, and independent grants survive detachment");
  await offline(["membership", "revoke", privateShare.id, "local", owner.id]);
  const calls = [], original = obsidian.requestUrl;
  try {
    obsidian.requestUrl = async options => { calls.push(options.url); return original(options); };
    for (const work of [() => client.service.history("Personal/same.md"),
      () => client.service.fileAtVersion("Personal/same.md", privateHash),
      () => client.service.blobAtVersion("Personal/same.bin", privateHash),
      () => client.service.devices(personal.mountId), () => client.service.deviceVersions("Personal/same.md"),
      () => client.service.saveVersionMetadata({ path: "Personal/same.md", hash: privateHash, name: "denied" }),
      () => client.service.shareCredentialInventory(personal.mountId)]) {
      await assert.rejects(work(), error => error.status === 404);
    }
  } finally { obsidian.requestUrl = original; }
  assert.ok(!calls.some(url => url.includes("/v1/users/")));
  await client.service.detachBinding(personal.mountId);
  assert.deepEqual(fs.readFileSync(credentialStore), credentialBytes);
  const dav = await fetch(`${client.settings.serverUrl}${native.webdavPath}`, { method: "PROPFIND",
    headers: { Authorization: `Basic ${Buffer.from(`${native.username}:${native.password}`).toString("base64")}`, Depth: "0" } });
  assert.equal(dav.status, 207);
  assert.equal(JSON.stringify(client.settings.composite.mounts[0]), sibling);
  log("FEAT-13 real-server mount history/credential scenario passed (4 stages). Synthetic disposable data only.");
};
