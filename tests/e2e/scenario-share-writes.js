const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sha = (text) => createHash("sha256").update(text).digest("hex");

module.exports = async ({ device, pending, serverFile, log, shareId, readerToken, obsidian, setCapability }) => {
  const A = device("v2-A");
  A.write("note.md", "base\n"); A.write("safe.md", "safe\n"); A.write("delete.md", "base\n");
  A.write("attachment.bin", Buffer.from([0, 255, 1]));
  A.write("merge.md", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  await A.service.stageShareSelection(shareId);
  await A.service.initializeShareUpload();
  const B = device("v2-B");
  await B.service.stageShareSelection(shareId); await B.service.initializeShareDownload(); await B.service.enableShareWrites();
  const restart = (d) => {
    d.settings = JSON.parse(JSON.stringify(d.settings));
    d.service = new A.service.constructor(d.vault, d.settings, async () => {});
  };
  log("C1. Writable v2 Markdown, attachments, histories and device/version metadata");
  A.write("note.md", "from A\n"); await A.service.sync(); await B.service.sync();
  assert.equal(B.read("note.md"), "from A\n");
  assert.deepEqual(fs.readFileSync(path.join(B.dir, "attachment.bin")), Buffer.from([0, 255, 1]));
  const history = await B.service.history("note.md");
  assert.ok(history.length >= 2);
  await B.service.saveVersionMetadata({ path: "note.md", hash: history[0].hash, name: "Synthetic version" });
  assert.equal((await B.service.history("note.md"))[0].name, "Synthetic version");
  assert.equal(Buffer.from((await B.service.fileAtVersion("note.md", history[0].hash)).contentBase64, "base64").toString(), "from A\n");
  assert.ok((await A.service.devices()).length > 0); await B.service.deviceVersions("note.md");

  log("C2. Overlapping text/binary edits, pending recovery and explicit server resolution");
  A.write("merge.md", A.read("merge.md").replace("one\n", "one from A\n"));
  B.write("merge.md", B.read("merge.md").replace("ten\n", "ten from B\n"));
  await A.service.sync(); await B.service.sync();
  assert.match(B.read("merge.md"), /one from A/); assert.match(B.read("merge.md"), /ten from B/);
  A.write("note.md", "A overlap\n"); B.write("note.md", "B overlap\n");
  A.write("safe.md", "A overlap\n"); B.write("safe.md", "B overlap\n");
  await A.service.sync();
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["note.md", "safe.md"]);
  assert.match(B.read("note.md"), /<<<<<<< server/);
  restart(B);
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["note.md", "safe.md"]);
  assert.deepEqual((await B.service.resolveConflicts([{ path: "note.md", kind: "text", content: "resolved\n" }])).map((file) => file.path), ["safe.md"]);
  assert.equal(serverFile("note.md"), "resolved\n"); assert.equal(B.read("note.md"), "resolved\n");
  assert.match(B.read("safe.md"), /<<<<<<< server/);
  await B.service.resolveConflicts([{ path: "safe.md", kind: "text", content: "safe resolved\n" }]);
  await A.service.sync();
  A.write("attachment.bin", "A binary"); B.write("attachment.bin", "B binary");
  await A.service.sync();
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["attachment.bin"]);
  assert.equal(B.read("attachment.bin"), "B binary");
  await B.service.resolveConflicts([{ path: "attachment.bin", kind: "current" }]);
  await A.service.sync(); assert.equal(A.read("attachment.bin"), "B binary");

  log("C3. Edit/delete conflict without resurrection and explicit deletion resolution");
  fs.rmSync(path.join(A.dir, "delete.md")); B.write("delete.md", "B edit before remote deletion\n");
  await A.service.sync();
  assert.deepEqual((await B.service.sync()).map((file) => file.path), ["delete.md"]);
  assert.equal(serverFile("delete.md"), null);
  await B.service.resolveConflicts([{ path: "delete.md", kind: "delete" }]);
  assert.equal(B.read("delete.md"), null);

  const original = obsidian.requestUrl;
  const calls = [];
  try {
    log("C4. Edits during upload remain detectable and blocked after restart");
    let edited = false;
    obsidian.requestUrl = async (request) => {
      calls.push(request.url);
      const response = await original(request);
      if (!edited && request.url.endsWith("/chunk")) { edited = true; B.write("safe.md", "newer unsent bytes\n"); }
      return response;
    };
    B.write("safe.md", "captured upload\n"); await B.service.sync();
    assert.equal(serverFile("safe.md"), "captured upload\n"); assert.equal(B.read("safe.md"), "newer unsent bytes\n");
    assert.equal(B.settings.activeShare.download.baseline.find((file) => file.path === "safe.md").sha256, sha("captured upload\n"));
    restart(B); await B.service.sync(); assert.equal(serverFile("safe.md"), "captured upload\n");
    obsidian.requestUrl = original;
    await B.service.uploadLocalReconciliation("safe.md"); assert.equal(serverFile("safe.md"), "newer unsent bytes\n");

    log("C5. Lost sync acknowledgement recovers matching remote contents without replay");
    let lost = false;
    obsidian.requestUrl = async (request) => {
      calls.push(request.url);
      const response = await original(request);
      if (!lost && request.url.endsWith("/sync") && JSON.parse(request.body).changes.length) {
        lost = true; throw new Error("synthetic lost acknowledgement");
      }
      return response;
    };
    B.write("note.md", "ack lost\n"); await assert.rejects(B.service.sync(), /lost acknowledgement/);
    const count = calls.filter((url) => url.endsWith("/uploads")).length;
    restart(B); await B.service.sync();
    assert.equal(calls.filter((url) => url.endsWith("/uploads")).length, count);
    assert.equal(B.settings.activeShare.download.writing, undefined);
    assert.equal(B.settings.activeShare.download.baseline.find((file) => file.path === "note.md").sha256, sha("ack lost\n"));
    obsidian.requestUrl = original;

    log("C6. Actual membership downgrade during staging; restoration/restart cannot upload blocked edits");
    let downgraded = false;
    obsidian.requestUrl = async (request) => {
      const response = await original(request);
      if (!downgraded && request.url.endsWith("/uploads")) { downgraded = true; await setCapability("read"); }
      return response;
    };
    B.write("note.md", "blocked by downgrade\n");
    await assert.rejects(B.service.sync(), /read-only/);
    assert.equal(serverFile("note.md"), "ack lost\n");
    assert.ok(B.settings.activeShare.download.reconciliation.some((file) => file.path === "note.md"));
    await setCapability("read-write"); obsidian.requestUrl = original;
    restart(B); await B.service.sync(); assert.equal(serverFile("note.md"), "ack lost\n");
    await B.service.uploadLocalReconciliation("note.md"); assert.equal(serverFile("note.md"), "blocked by downgrade\n");
  } finally { obsidian.requestUrl = original; }
  assert.ok(calls.every((url) => !url.includes("/register") && !url.includes("/v1/users/")));
  assert.deepEqual(pending(), []);
  log("C7. Native InkVault v2 publication and feature/capability gates; ordinary client receives only PDF");
  function cbor(value) {
    const head = (type, n) => n < 24 ? Buffer.from([type * 32 + n]) : n <= 255 ? Buffer.from([type * 32 + 24, n])
      : n <= 65535 ? Buffer.from([type * 32 + 25, n >> 8, n & 255])
      : Buffer.from([type * 32 + 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    if (typeof value === "number") return head(0, value);
    if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
    if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
    const fields = Object.entries(value).map(([k, v]) => [cbor(k), cbor(v)])
      .sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
    return Buffer.concat([head(5, fields.length), ...fields.flat()]);
  }
  const root = ".inkvault/notes/11111111-1111-4111-8111-111111111111";
  const pageId = "22222222-2222-4222-8222-222222222222";
  const page = cbor({ schemaVersion: 1, width: 210000, height: 297000, strokes: [], objects: [], tombstones: [] });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, documentId: root.split("/").pop(), pdfPath: "Notes/Test.pdf",
    title: "Synthetic InkVault", created: 1, modified: 1, sourceRevision: 1, renderRevision: "",
    pages: [{ id: pageId, width: 210000, height: 297000, orientation: "portrait", template: null, sha256: sha(page) }] }));
  const headers = { authorization: `Bearer ${A.settings.oidcAccessToken}`, "content-type": "application/json" };
  const url = `${A.settings.serverUrl}/v2/shares/${shareId}`;
  const state = await (await fetch(`${url}/sync-state`, { headers })).json();
  const body = JSON.stringify({ baseHead: state.serverHead, clientId: "native-synthetic", deviceName: "Native fixture", clientManifest: [],
    fileContent: "reference", changes: [[`${root}/manifest.json`, manifest], [`${root}/pages/${pageId}.cbor`, page]]
      .map(([path, bytes]) => ({ path, op: "upsert", sha256: sha(bytes), contentBase64: bytes.toString("base64") })) });
  const ungated = await fetch(`${url}/sync`, { method: "POST", headers, body }); assert.equal(ungated.status, 400);
  const nativeHeaders = { ...headers, "x-obsidisync-client-features": "inkVaultNotesV1" };
  const denied = await fetch(`${url}/sync`, { method: "POST", headers: { ...nativeHeaders, authorization: `Bearer ${readerToken}` }, body });
  assert.equal(denied.status, 403);
  const published = await fetch(`${url}/sync`, { method: "POST", headers: nativeHeaders, body });
  assert.equal(published.status, 200, await published.text());
  await A.service.sync();
  assert.equal(A.read(`${root}/manifest.json`), null);
  assert.ok(fs.readFileSync(path.join(A.dir, "Notes/Test.pdf")).subarray(0, 5).equals(Buffer.from("%PDF-")));
  A.write("Notes/Test.pdf", "ordinary client cannot overwrite managed PDF");
  await assert.rejects(A.service.sync(), /requires inkVaultNotesV1/);
  await A.service.sync();
  assert.equal(A.settings.activeShare.download.reconciliation.find((file) => file.path === "Notes/Test.pdf").uploadBlocked, true);
  await A.service.useRemoteReconciliation("Notes/Test.pdf");
  assert.ok(fs.readFileSync(path.join(A.dir, "Notes/Test.pdf")).subarray(0, 5).equals(Buffer.from("%PDF-")));
  log("C8. Initial upload concurrency fails visibly without deleting the remote tree");
  const C = device("v2-initial-concurrent"); C.write("note.md", "initial replacement\n");
  C.write("Notes/Test.pdf", fs.readFileSync(path.join(A.dir, "Notes/Test.pdf")));
  await C.service.stageShareSelection(shareId);
  let advanced = false;
  try {
    obsidian.requestUrl = async (request) => {
      const response = await original(request);
      if (!advanced && request.url.endsWith("/uploads")) {
        advanced = true; A.write("note.md", "concurrent initial change\n"); await A.service.sync();
      }
      return response;
    };
    await assert.rejects(C.service.initializeShareUpload(), /concurrent remote changes/);
    assert.equal(serverFile("note.md"), "concurrent initial change\n");
    assert.notEqual(serverFile("safe.md"), null, "Failed initial upload cannot delete unrelated remote files");
    assert.match(C.read("note.md"), /<<<<<<< server/);
    assert.equal(C.settings.activeShare.status, "writable");
    assert.ok(C.settings.activeShare.download.initial.backupFolder);
  } finally { obsidian.requestUrl = original; }
  log("FEAT-04C real-server writable scenario passed (8 stages); synthetic disposable data only.");
};
