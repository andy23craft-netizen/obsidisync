const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async ({ device, log, offline, dataDir, obsidian }) => {
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json"), "utf8"));
  const owner = accounts.accounts.find(account => account.user === "dev");
  const shares = [];
  for (const label of ["Private conversion", "Household conversion", "Recovered private conversion"]) {
    const share = await offline(["share", "create", label]);
    await offline(["membership", "grant", share.id, "local", owner.id, "read-write"]);
    const setup = path.join(path.dirname(dataDir), `conversion-${share.id}.json`);
    fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
      authorName: "Synthetic conversion", authorEmail: "fixture@example.invalid" } }));
    await offline(["share", "setup", share.id, setup]); shares.push(share);
  }
  const remote = (index, file) => {
    const full = path.join(dataDir, "shares", shares[index].id, "repo", file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };
  const restart = client => {
    client.settings = JSON.parse(fs.readFileSync(client.settingsPath, "utf8"));
    client.service = new client.service.constructor(client.vault, client.settings,
      async () => client.persist(client.settings), undefined, undefined, client.persist);
  };
  log("J1. Existing v1 bytes convert with verified settings evidence and no target publication");
  const client = device("conversion-v1");
  client.write("private.md", "private original\n"); client.write("attachment.bin", Buffer.from([0, 255, 3]));
  await client.service.sync();
  const originalHead = client.settings.serverHead;
  const preview = await client.service.previewConversion([
    { shareId: shares[0].id, localPrefix: "Personal" }, { shareId: shares[1].id, localPrefix: "Harmony" }
  ], [{ source: "private.md", destination: "Personal/private.md" },
    { source: "attachment.bin", destination: "Harmony/attachment.bin" }]);
  await client.service.convertBinding(preview);
  restart(client);
  assert.equal(client.settings.conversion.original.serverHead, originalHead);
  assert.equal(client.settings.conversion.phase, "activated");
  assert.equal(client.read("private.md"), null); assert.equal(client.read("Personal/private.md"), "private original\n");
  assert.equal(remote(0, "private.md"), null); assert.equal(remote(1, "attachment.bin"), null);
  assert.ok(client.settings.composite.mounts.every(mount => !mount.initialized && mount.status === "download-only"));
  for (const mount of client.settings.composite.mounts) await client.service.initializeShareUpload(mount.mountId);

  log("J2. Selected-share conversion preserves attribution and resets target reconciliation state");
  const selected = device("conversion-selected");
  await selected.service.stageShareSelection(shares[0].id);
  await selected.service.initializeShareDownload();
  selected.write("retained.md", "retained selected\n");
  const selectedPreview = await selected.service.previewConversion([{ shareId: shares[0].id, localPrefix: "Retained" }],
    [{ source: "private.md", destination: "Retained/private.md" }, { source: "retained.md", destination: "Retained/retained.md" }]);
  await selected.service.convertBinding(selectedPreview);
  assert.equal(selected.settings.conversion.original.activeShare.shareId, shares[0].id);
  assert.equal(selected.settings.composite.mounts[0].download.baseline.length, 0);

  log("J3. Detachment drains a committed write with lost acknowledgement after membership removal");
  const issuer = device("conversion-grant-issuer");
  await issuer.service.stageShareSelection(shares[0].id);
  const grant = await issuer.service.createShareCredential("Synthetic independent grant", "Tablet", "read");
  await offline(["credential", "share", "activate", grant.id]);
  const grantPath = path.join(dataDir, "auth/share-device-passwords.json");
  const grantBytes = fs.readFileSync(grantPath);
  const lostMount = client.settings.composite.mounts[0];
  const stale = client.service.compositeActionGuard(lostMount.mountId);
  const siblingBefore = JSON.stringify(client.settings.composite.mounts[1]);
  const request = obsidian.requestUrl;
  let detach;
  try {
    obsidian.requestUrl = async options => {
      const result = await request(options);
      if (!detach && options.method === "POST" && options.url.endsWith(`/v2/shares/${shares[0].id}/sync`)) {
        await offline(["membership", "revoke", shares[0].id, "local", owner.id]);
        detach = client.service.detachBinding(lostMount.mountId);
      }
      return result;
    };
    client.write("Personal/private.md", "committed but unacknowledged\n");
    await assert.rejects(client.service.sync(), /invalidated|stale/);
    await detach;
  } finally { obsidian.requestUrl = request; }
  assert.equal(remote(0, "private.md"), "committed but unacknowledged\n");
  assert.equal(client.read("Personal/private.md"), "committed but unacknowledged\n");
  assert.throws(stale, /stale|invalidated/);
  assert.equal(JSON.stringify(client.settings.composite.mounts[0]), siblingBefore);
  assert.equal(client.settings.bindingArchives.entries[0].original.composite.mounts[0].download.writing.stage, "submitted");
  assert.deepEqual(fs.readFileSync(grantPath), grantBytes);
  restart(client);
  assert.equal(client.settings.bindingArchives.entries[0].unresolved, true);

  log("J4. Retained files convert separately to a new authorized destination without old access");
  const recovered = await client.service.previewConversion([{ shareId: shares[2].id, localPrefix: "Recovered" }],
    [{ source: "Personal/private.md", destination: "Recovered/private.md" }]);
  await client.service.convertBinding(recovered);
  assert.equal(client.read("Recovered/private.md"), "committed but unacknowledged\n");
  assert.equal(remote(2, "private.md"), null);
  assert.equal(client.settings.composite.mounts.find(mount => mount.shareId === shares[2].id).download.writing, undefined);
  assert.equal(JSON.stringify(client.settings.composite.mounts[0]), siblingBefore);

  log("J5. Restored access creates a new mount without replaying archived writes or retargeting grants");
  await offline(["membership", "grant", shares[0].id, "local", owner.id, "read-write"]);
  const readd = await client.service.previewConversion([{ shareId: shares[0].id, localPrefix: "Personal" }], []);
  await client.service.convertBinding(readd);
  const fresh = client.settings.composite.mounts.find(mount => mount.shareId === shares[0].id);
  assert.notEqual(fresh.mountId, lostMount.mountId); assert.equal(fresh.initialized, false);
  assert.equal(fresh.download.writing, undefined); assert.deepEqual(fresh.download.baseline, []);
  await client.service.initializeCompositeMount(fresh.mountId);
  assert.equal(remote(0, "private.md"), "committed but unacknowledged\n");
  assert.deepEqual(fs.readFileSync(grantPath), grantBytes);
  log("FEAT-12 real-server lifecycle scenario passed (5 stages). Disposable synthetic data only.");
};
