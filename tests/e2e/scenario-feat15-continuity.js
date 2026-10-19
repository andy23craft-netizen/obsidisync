const assert = require("node:assert/strict");

module.exports = async ({ device, log, shareId }) => {
  const computer = device("feat15-computer");
  const phone = device("feat15-phone");
  for (const client of [computer, phone]) {
    await client.service.addCompositeMount(shareId, "Harmony");
    const mount = client.service.compositeMounts()[0];
    await client.service.initializeCompositeMount(mount.mountId);
    await client.service.enableShareWrites(mount.mountId);
  }

  log("FEAT-15 E1. Computer additions and binary attachments reach the phone on its next sync");
  computer.write("Harmony/from-computer.md", "computer addition\n");
  computer.write("Harmony/attachment.bin", Buffer.from([0, 1, 127, 255]));
  await computer.service.sync(); await phone.service.sync();
  assert.equal(phone.read("Harmony/from-computer.md"), "computer addition\n");
  assert.deepEqual(require("node:fs").readFileSync(`${phone.dir}/Harmony/attachment.bin`), Buffer.from([0, 1, 127, 255]));

  log("FEAT-15 E2. Phone edits and deletions return to the computer after a persisted-client restart");
  phone.write("Harmony/from-computer.md", "phone edit\n");
  phone.write("Harmony/phone-only.md", "phone addition\n");
  await phone.service.sync();
  let restartedComputer = device("feat15-computer", {}, true);
  await restartedComputer.service.sync();
  assert.equal(restartedComputer.read("Harmony/from-computer.md"), "phone edit\n");
  assert.equal(restartedComputer.read("Harmony/phone-only.md"), "phone addition\n");

  require("node:fs").unlinkSync(`${phone.dir}/Harmony/from-computer.md`);
  await phone.service.sync();
  restartedComputer = device("feat15-computer", {}, true);
  await restartedComputer.service.sync();
  assert.equal(restartedComputer.read("Harmony/from-computer.md"), null);
  assert.equal(restartedComputer.service.compositeMounts()[0].download.reconciliation.length, 0);
  assert.ok(restartedComputer.service.compositeMounts()[0].download.initial.complete);
  log("FEAT-15 two-client persisted composite sync scenario passed. Synthetic data only.");
};
