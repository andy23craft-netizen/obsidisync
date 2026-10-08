import test from "node:test";
import assert from "node:assert/strict";
import type { ServerAuthConfig } from "../src/gitService";

// Exercise the actual login modal/service with a narrow Obsidian stand-in.
const Module = require("node:module") as { _load: (...args: any[]) => any };
const load = Module._load;
let fields: string[] = [];
let texts: string[] = [];
let responses: any[] = [];
let requests: any[] = [];
class Modal {
  contentEl = {
    empty: () => { texts = []; },
    createEl: (_tag: string, options: { text: string }) => {
      texts.push(options.text);
      return { setText: (text: string) => texts.push(text) };
    }
  };
  close() {}
}
class Setting {
  setName(name: string) { fields.push(name); return this; }
  addText(callback: (text: any) => void) {
    const text = { inputEl: {}, setPlaceholder: () => text, onChange: () => text };
    callback(text); return this;
  }
  addButton(callback: (button: any) => void) {
    const button = { setCta: () => button, setButtonText: () => button, onClick: () => button };
    callback(button); return this;
  }
}
const mock = {
  Modal, Setting, Notice: class {},
  requestUrl: async (request: any) => {
    requests.push(request);
    assert.ok(responses.length, "unexpected HTTP request");
    return responses.shift();
  }
};
Module._load = function (name: string, ...args: any[]) {
  return name === "obsidian" ? mock : load.call(this, name, ...args);
};
const { AuthLoginModal } = require("../src/authLoginModal");
const { GitService } = require("../src/gitService");
Module._load = load;

async function render(config: ServerAuthConfig) {
  fields = []; texts = [];
  const modal = new AuthLoginModal({}, { authConfig: async () => config }, () => {});
  await modal.onOpen();
}
test("host-local empty discovery displays operator guidance without credential controls", async () => {
  await render({ type: "password", passwordConfigured: true, accountProvisioning: "host-local", loginAvailable: false });
  assert.deepEqual(fields, []);
  assert.ok(texts.some((text) => text.includes("server operator")));
});
test("provisioned host-local accounts offer ordinary login and old-server setup remains compatible", async () => {
  await render({ type: "password", passwordConfigured: true, accountProvisioning: "host-local", loginAvailable: true });
  assert.deepEqual(fields, ["Username", "Password"]);
  await render({ type: "password", passwordConfigured: false, setupTokenRequired: true });
  assert.deepEqual(fields, ["Username", "Password", "Confirm password", "Setup token"]);
});
test("rejected refresh then password re-login retains registration, head, manifest and recovery state", async () => {
  const manifest = [{ path: "Note.md", sha256: "fixture-hash", size: 8, mtime: 1 }];
  const settings: any = {
    serverUrl: "http://localhost:8787", userSlug: "andy", vaultSlug: "notes", initialSyncDone: true,
    serverHead: "fixture-head", localManifest: manifest, clientId: "fixture-device",
    historySnapshots: [{ snapshotPath: "recovery/Note.md", sourcePath: "Note.md", hash: "fixture-head" }],
    historyVersions: [], serverFeatures: [], oidcAccessToken: "old-access", oidcRefreshToken: "old-refresh",
    oidcAccessTokenExpiresAt: "2000-01-01T00:00:00Z", lastLoginError: null
  };
  const state = JSON.stringify([settings.vaultSlug, settings.initialSyncDone, settings.serverHead,
    settings.localManifest, settings.clientId, settings.historySnapshots, settings.historyVersions]);
  const service = new GitService({}, settings, async () => {});
  responses = [{ status: 401, json: {}, text: "unauthorized" }]; requests = [];
  assert.equal(await service.refreshOidcAccessToken(), false);
  assert.equal(settings.oidcRefreshToken, "");
  responses = [{ status: 200, json: { user: "andy", subject: "p_fixture", accessToken: "new-access",
    refreshToken: "new-refresh", expiresIn: 86400, refreshExpiresIn: 15552000 } }];
  await service.loginPassword("andy", "fixture-password", false);
  assert.equal(settings.oidcAccessToken, "new-access");
  assert.equal(JSON.stringify([settings.vaultSlug, settings.initialSyncDone, settings.serverHead,
    settings.localManifest, settings.clientId, settings.historySnapshots, settings.historyVersions]), state);
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ["/v1/auth/session/refresh", "/v1/auth/password/login"]);
});
