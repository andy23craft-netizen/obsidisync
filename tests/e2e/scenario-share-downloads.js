const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function fingerprint(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push([path.relative(root, full), createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  }
  walk(root);
  return JSON.stringify(files);
}

module.exports = async ({ device, pending, serverFile, log, shareId, readerToken, shareRoot }) => {
  const writer = device("writer");
  writer.write("grocery.md", "base\n"); writer.write("safe.md", "base\n"); writer.write("deleted.md", "base\n");
  writer.write("attachment.bin", "synthetic binary fixture");
  await writer.service.sync();
  const reader = device("reader", { userSlug: "reader", oidcAccessToken: readerToken });
  reader.write("grocery.md", "pre-migration local\n");
  log("B1. Read-only share initial download backs up local bytes without server mutation");
  const beforeInitial = fingerprint(shareRoot);
  await reader.service.stageShareSelection(shareId);
  await reader.service.initializeShareDownload();
  assert.equal(reader.settings.activeShare.capability, "read");
  assert.equal(reader.read("grocery.md"), "base\n");
  assert.equal(reader.read(`${reader.settings.activeShare.download.initial.backupFolder}/grocery.md`), "pre-migration local\n");
  assert.equal(fingerprint(shareRoot), beforeInitial);

  log("B2. Read-only mixed updates and remote deletion preserve local edits, advance safe baseline");
  reader.write("grocery.md", "unsent local\n"); reader.write("deleted.md", "unsent before deletion\n");
  writer.write("grocery.md", "remote update\n"); writer.write("safe.md", "safe update\n");
  fs.rmSync(path.join(writer.dir, "deleted.md"));
  await writer.service.sync();
  const beforeRead = fingerprint(shareRoot);
  await reader.service.sync();
  assert.equal(reader.read("grocery.md"), "unsent local\n"); assert.equal(reader.read("safe.md"), "safe update\n");
  assert.equal(reader.read("deleted.md"), "unsent before deletion\n");
  assert.equal(reader.settings.activeShare.download.reconciliation.length, 2);
  assert.equal(fingerprint(shareRoot), beforeRead); assert.deepEqual(pending(), []);
  assert.equal(serverFile("grocery.md"), "remote update\n");

  log("B3. Authorized history/current files and local reconciliation do not mutate server storage");
  const history = await reader.service.history("grocery.md"); assert.ok(history.length > 0);
  assert.equal(Buffer.from((await reader.service.fileAtVersion("grocery.md", history[0].hash)).contentBase64, "base64").toString(), "remote update\n");
  await reader.service.deviceVersions("grocery.md");
  await reader.service.keepLocalReconciliation("grocery.md");
  assert.equal(reader.settings.activeShare.download.reconciliation.find((entry) => entry.path === "grocery.md").uploadBlocked, true);
  await reader.service.useRemoteReconciliation("deleted.md"); assert.equal(reader.read("deleted.md"), null);
  assert.equal(fingerprint(shareRoot), beforeRead);
  await assert.rejects(reader.service.forcePushLocal(), /not enabled/);
  log("FEAT-04B real-server scenario passed (3 stages). No production data used.");
};
