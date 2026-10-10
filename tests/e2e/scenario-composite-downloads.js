const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function fingerprint(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push([path.relative(root, full), createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  }
  walk(root);
  return JSON.stringify(entries);
}

module.exports = async ({ device, log, shareId, readerToken, shareRoot, offline, dataDir }) => {
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "auth/accounts.json"), "utf8"));
  const owner = accounts.accounts.find((account) => account.user === "dev");
  const reader = accounts.accounts.find((account) => account.user === "reader");
  const privateA = await offline(["share", "create", "Synthetic private A"]);
  const privateB = await offline(["share", "create", "Synthetic private B"]);
  for (const [share, account] of [[privateA, owner], [privateB, reader]]) {
    await offline(["membership", "grant", share.id, "local", account.id, "read-write"]);
    const setup = path.join(path.dirname(dataDir), `composite-${share.id}.json`);
    fs.writeFileSync(setup, JSON.stringify({ registration: { remoteUrl: "", branch: "main",
      authorName: "Synthetic Composite", authorEmail: "fixture@example.invalid" } }));
    await offline(["share", "setup", share.id, setup]);
  }
  const sharedWriter = device("composite-shared-writer");
  sharedWriter.write("same.md", "shared base\n"); sharedWriter.write("image.bin", "shared attachment");
  await sharedWriter.service.sync();
  for (const [share, token, user, contents] of [
    [privateA, sharedWriter.settings.oidcAccessToken, "dev", "private A\n"],
    [privateB, readerToken, "reader", "private B\n"]
  ]) {
    const seed = device(`composite-seed-${user}`, { oidcAccessToken: token, userSlug: user });
    seed.write("same.md", contents); seed.write("image.bin", `attachment ${user}`);
    await seed.service.stageShareSelection(share.id); await seed.service.initializeShareUpload();
  }
  const roots = [shareRoot, ...[privateA, privateB].map((share) => path.join(dataDir, "shares", share.id))];
  const before = roots.map(fingerprint);
  const a = device("composite-A");
  const b = device("composite-B", { oidcAccessToken: readerToken, userSlug: "reader" });
  log("M1. Two principals download isolated private and shared mounts without server mutation");
  for (const [client, personal] of [[a, privateA], [b, privateB]]) {
    await client.service.addCompositeMount(personal.id, "Personal");
    await client.service.addCompositeMount(shareId, "Harmony");
    assert.equal(client.read("Personal/same.md"), null);
    for (const mount of client.settings.composite.mounts) await client.service.initializeCompositeMount(mount.mountId);
    assert.equal(client.read("Harmony/same.md"), "shared base\n");
    assert.equal(client.read("Harmony/image.bin"), "shared attachment");
  }
  assert.equal(a.read("Personal/same.md"), "private A\n"); assert.equal(b.read("Personal/same.md"), "private B\n");
  assert.deepEqual(roots.map(fingerprint), before);

  log("M2. Discovery and direct content/blob requests cannot expose the other principal's private share");
  const server = sharedWriter.settings.serverUrl;
  for (const [client, inaccessible] of [[a, privateB.id], [b, privateA.id]]) {
    const headers = { authorization: `Bearer ${client.settings.oidcAccessToken}` };
    const listing = await (await fetch(`${server}/v2/shares`, { headers })).json();
    assert.ok(!listing.some((share) => share.shareId === inaccessible));
    for (const suffix of ["sync-state", "file?path=same.md", "blob?path=image.bin", "history?path=same.md"]) {
      const denied = await fetch(`${server}/v2/shares/${inaccessible}/${suffix}`, { headers });
      const missing = await fetch(`${server}/v2/shares/s_ffffffffffffffffffffffffffffffff/${suffix}`, { headers });
      assert.equal(denied.status, 404); assert.equal(missing.status, 404);
      assert.equal(await denied.text(), await missing.text());
    }
  }
  assert.deepEqual(roots.map(fingerprint), before);

  log("M3. Shared updates preserve private edits, and detected cross-mount moves retain barriers");
  a.write("Personal/same.md", "local private edit\n");
  sharedWriter.write("same.md", "shared update\n"); await sharedWriter.service.sync();
  const afterWrite = roots.map(fingerprint);
  await a.service.sync(); await b.service.sync();
  assert.equal(a.read("Personal/same.md"), "local private edit\n");
  assert.equal(a.read("Harmony/same.md"), "shared update\n"); assert.equal(b.read("Harmony/same.md"), "shared update\n");
  fs.renameSync(path.join(a.dir, "Personal/same.md"), path.join(a.dir, "Harmony/imported.md"));
  await a.service.observeCompositeRename("Personal/same.md", "Harmony/imported.md"); await a.service.sync();
  assert.equal(a.read("Personal/same.md"), null); assert.equal(a.read("Harmony/imported.md"), "local private edit\n");
  assert.ok(a.settings.composite.mounts.every((mount) => mount.barriers.length > 0));
  assert.deepEqual(roots.map(fingerprint), afterWrite);
  log("FEAT-10 real-server composite scenario passed (3 stages). Disposable synthetic data only.");
};
