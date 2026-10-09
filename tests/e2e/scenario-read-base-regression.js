// Focused FEAT-04C v2 base contract regression, using only disposable server storage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

module.exports = async ({ device, serverFile, shareId, shareRoot, log }) => {
  const writer = device("seed");
  writer.write("grocery.md", "original fixture note\n");
  writer.write("legacy.md", "legacy fixture\n");
  writer.write("same.md", "same fixture\n");
  writer.write("a.bin", "original binary");
  await writer.service.sync();

  // A read-write member downloads using B's non-mutating v2 path, without legacy registration/device writes.
  const downloaded = device("read-first");
  await downloaded.service.stageShareSelection(shareId);
  await downloaded.service.initializeShareDownload();
  const base = downloaded.settings.activeShare.download.observedHead;
  const devices = JSON.parse(fs.readFileSync(path.join(shareRoot, "devices.json"), "utf8"));
  assert.equal(devices.devices[downloaded.settings.clientId], undefined);
  assert.equal(downloaded.read("grocery.md"), "original fixture note\n");

  downloaded.write("grocery.md", "unsent fixture edit\n");
  fs.rmSync(path.join(writer.dir, "grocery.md"));
  fs.rmSync(path.join(writer.dir, "legacy.md"));
  fs.rmSync(path.join(writer.dir, "same.md"));
  writer.write("a.bin", "changed binary");
  writer.write("concurrent.md", "other creator\n");
  await writer.service.sync();
  assert.equal(serverFile("grocery.md"), null);

  // Exercise the v2 write contract directly; this device deliberately remains download-only.
  const bytes = Buffer.from(downloaded.read("grocery.md"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await fetch(`${downloaded.settings.serverUrl}/v2/shares/${shareId}/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${downloaded.settings.oidcAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ baseHead: base, clientId: downloaded.settings.clientId, deviceName: "Synthetic read-first",
      changes: [{ path: "grocery.md", op: "upsert", contentBase64: bytes.toString("base64"), sha256 }],
      clientManifest: [{ path: "grocery.md", sha256, size: bytes.length, mtime: 1 }], fileContent: "reference" })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  log(`Read-first edit/delete diagnostic: status=${result.status}; conflicts=${result.conflicts.length}; deleted file recreated=${serverFile("grocery.md") !== null}`);
  assert.equal(result.status, "conflict", "A downloaded base must not be mistaken for a never-seen create");
  assert.match(result.conflicts[0].reason, /server deleted file while client edited/);
  assert.equal(serverFile("grocery.md"), null);

  let sequence = 0;
  async function send(file, content, revision = base, legacy = false) {
    const bytes = Buffer.from(content);
    const response = await fetch(`${downloaded.settings.serverUrl}${legacy ? "/v1/users/dev/vaults/harness" : `/v2/shares/${shareId}`}/sync`, {
      method: "POST", headers: { Authorization: `Bearer ${downloaded.settings.oidcAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ baseHead: revision, clientId: `contract-${++sequence}`, deviceName: "Synthetic contract",
        changes: [{ path: file, op: "upsert", contentBase64: bytes.toString("base64") }], clientManifest: [], fileContent: "reference" })
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await send("legacy.md", "legacy edit", base, true)).body.status, "ok", "V1 retains missing-ack create semantics");
  assert.equal((await send("same.md", "same fixture\n")).body.status, "ok");
  assert.equal(serverFile("same.md"), null, "An unchanged stale file does not undo deletion");
  assert.equal((await send("new.md", "genuine new\n")).body.status, "ok");
  assert.equal(serverFile("new.md"), "genuine new\n");
  assert.equal((await send("concurrent.md", "second creator\n")).body.status, "conflict");
  assert.equal((await send("a.bin", "conflicting binary")).body.status, "conflict");
  assert.equal((await send("stable.md", "create", null)).body.status, "ok");
  const currentBase = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.join(shareRoot, "repo"), encoding: "utf8" });
  assert.equal(currentBase.status, 0);
  assert.equal((await send("stable.md", "ordinary edit", currentBase.stdout.trim())).body.status, "ok");
  assert.equal(serverFile("stable.md"), "ordinary edit", "A base-present/current-present edit remains non-conflicting without a device ack");

  for (const revision of ["not-a-revision", "0".repeat(40)]) {
    assert.notEqual((await send("invalid.md", "must not write", revision)).status, 200);
    assert.equal(serverFile("invalid.md"), null);
  }
  const unrelated = path.join(path.dirname(shareRoot), "unrelated-fixture");
  fs.mkdirSync(unrelated, { recursive: true });
  function git(cwd, args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(unrelated, ["init", "-b", "main"]);
  git(unrelated, ["config", "user.name", "Synthetic"]);
  git(unrelated, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(unrelated, "foreign.md"), "foreign fixture");
  git(unrelated, ["add", "foreign.md"]); git(unrelated, ["commit", "-m", "synthetic foreign base"]);
  const foreign = git(unrelated, ["rev-parse", "HEAD"]);
  assert.notEqual((await send("foreign.md", "must not write", foreign)).status, 200);
  // Even an existing Git object is not a valid base when it is outside the selected share's ancestry.
  git(path.join(shareRoot, "repo"), ["fetch", unrelated, "main"]);
  assert.notEqual((await send("foreign.md", "must not write", foreign)).status, 200);
  assert.equal(serverFile("foreign.md"), null);
  // A valid commit with an unavailable base blob is uncertainty, not proof of a never-seen path.
  const blob = git(path.join(shareRoot, "repo"), ["rev-parse", `${base}:same.md`]);
  fs.rmSync(path.join(shareRoot, "repo", ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  assert.notEqual((await send("same.md", "must not recreate from unreadable base", base)).status, 200);
  assert.equal(serverFile("same.md"), null);
  log("V2 base contract: edit/delete, unchanged deletion, genuine/concurrent creation, binary conflicts, invalid/foreign/unreachable bases and v1 compatibility passed");
};
