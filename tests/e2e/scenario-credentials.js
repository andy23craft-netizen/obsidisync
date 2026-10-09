const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async ({ device, shareId, readerToken, log, setCapability, offline, dataDir }) => {
  const A = device("credential-owner");
  const base = A.settings.serverUrl;
  const legacy = await A.service.createDevicePassword("Synthetic legacy", "Tablet");
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json")));
  const owner = accounts.accounts.find(account => account.user === "dev");
  const saber = await offline(["credential", "legacy", "create-saber", "dev", "harness", "Saber/Sync", "Saber/PDFs",
    "Synthetic Saber", "local", owner.id], "synthetic-saber-encryption\n");
  const saberRecord = () => JSON.parse(fs.readFileSync(path.join(dataDir, "auth/device-passwords.json")))
    .passwords.find(entry => entry.id === saber.id);
  const originalSaber = saberRecord();
  const inventoryBefore = await A.service.listDevicePasswords();
  const credentialStore = path.join(dataDir, "auth/share-device-passwords.json");
  await A.service.stageShareSelection(shareId);
  const retained = JSON.stringify(A.settings.legacyManagementContext);
  const syncState = JSON.stringify([A.settings.serverHead, A.settings.localManifest, A.settings.pendingShareSelection.syncState]);
  log("D1. Legacy inventory and original IDs/URLs survive v2 selection and restart");
  assert.deepEqual(await A.service.listDevicePasswords(), inventoryBefore);
  assert.equal((await A.service.legacyCredentialInventory()).managementAllowed, true);
  A.settings = JSON.parse(JSON.stringify(A.settings));
  A.service = new A.service.constructor(A.vault, A.settings, async () => {});
  assert.equal((await A.service.listDevicePasswords())[0].id, legacy.id);
  assert.equal((await A.service.listDevicePasswords())[0].webdavPath, legacy.webdavPath);
  const status = async (url, username, password, method = "PROPFIND", body) => {
    const response = await fetch(`${base}${url}`, { method,
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, Depth: "0" }, body });
    return response.status;
  };
  assert.equal(await status(`${legacy.webdavPath}fixture.md`, legacy.username, legacy.password, "PUT", "synthetic legacy\n"), 201);
  const R = device("credential-reader", { userSlug: "reader", oidcAccessToken: readerToken });
  await R.service.stageShareSelection(shareId);
  R.settings.legacyManagementContext = { ...A.settings.legacyManagementContext };
  await assert.rejects(R.service.listDevicePasswords(), error => error.status === 404);

  log("D2. Staged read grant, immutable identity/URLs, offline activation and persisted secret hash");
  const created = await A.service.createShareCredential("Synthetic share DAV", "Tablet", "read");
  assert.equal(created.lifecycle, "staged");
  assert.equal(created.username, shareId);
  assert.equal(created.webdavPath, `/dav/${shareId}/Tablet/`);
  assert.equal(created.nextcloudPath, `/remote.php/dav/files/${shareId}/Tablet/`);
  assert.equal(await status(created.webdavPath, created.username, created.password), 401);
  const stagedBytes = fs.readFileSync(credentialStore);
  await offline(["credential", "share", "activate", created.id]);
  assert.deepEqual(fs.readFileSync(credentialStore), stagedBytes);
  assert.equal(await status(created.webdavPath, shareId, created.password), 207);
  assert.equal(await status(created.nextcloudPath, shareId, created.password), 207);
  assert.equal(await status(`/dav/${shareId}/Outside/`, shareId, created.password), 404);
  assert.equal(await status(`${created.webdavPath}new.md`, shareId, created.password, "PUT", "denied"), 403);
  let inventory = await A.service.shareCredentialInventory();
  assert.equal(inventory.entries.find(entry => entry.id === created.id).lifecycle, "active");
  assert.ok(!JSON.stringify(inventory).includes(created.password));
  assert.ok(!JSON.stringify(inventory).includes("secret_hash"));
  assert.ok(inventory.entries.every(entry => entry.kind === "webdav"));

  log("D3. Read-only management boundaries and independent grants across downgrade and restart");
  await setCapability("read");
  assert.equal((await A.service.legacyCredentialInventory()).managementAllowed, false);
  await assert.rejects(A.service.createDevicePassword("Denied", "Tablet"), error => error.status === 404 || error.status === 403);
  await assert.rejects(A.service.revokeDevicePassword(legacy.id), error => error.status === 404 || error.status === 403);
  const readGrant = await A.service.createShareCredential("Synthetic reader grant", "Tablet", "read");
  await assert.rejects(A.service.createShareCredential("Denied", "Tablet", "read-write"), /read-only/);
  await assert.rejects(A.service.revokeShareCredential(readGrant.id), /host-operator/);
  assert.equal(await status(created.webdavPath, shareId, created.password), 207);
  assert.equal(await status(legacy.webdavPath, legacy.username, legacy.password), 207);
  await offline();
  assert.equal(await status(created.nextcloudPath, shareId, created.password), 207);
  assert.equal((await A.service.shareCredentialInventory()).entries.find(entry => entry.id === readGrant.id).lifecycle, "staged");

  log("D4. Creator removal denies session management but explicit host revocation still works");
  await offline(["membership", "revoke", shareId, "local", owner.id]);
  await assert.rejects(A.service.listDevicePasswords(), error => error.status === 404);
  await assert.rejects(A.service.shareCredentialInventory(), error => error.status === 404);
  assert.equal(await status(created.webdavPath, shareId, created.password), 207);
  assert.equal(await status(legacy.webdavPath, legacy.username, legacy.password), 207);
  await offline(["credential", "share", "revoke", created.id]);
  assert.equal(await status(created.webdavPath, shareId, created.password), 401);
  await setCapability("read-write");
  await A.service.revokeShareCredential(readGrant.id);
  await A.service.revokeDevicePassword(legacy.id);
  assert.equal(await status(legacy.webdavPath, legacy.username, legacy.password), 401);
  assert.equal(JSON.stringify(A.settings.legacyManagementContext), retained);
  assert.equal(JSON.stringify([A.settings.serverHead, A.settings.localManifest, A.settings.pendingShareSelection.syncState]), syncState);
  assert.ok(!JSON.stringify(A.settings).includes(created.password));
  assert.deepEqual(saberRecord(), originalSaber, "selection and management never rewrite legacy Saber configuration or hash");
  assert.ok(!JSON.stringify(await A.service.listDevicePasswords()).includes("synthetic-saber-encryption"));
  await A.service.revokeDevicePassword(saber.id);
  assert.equal(saberRecord(), undefined);
  log("D credential lifecycle scenario passed");
};
