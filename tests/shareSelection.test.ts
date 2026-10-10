import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const Module = require("node:module") as { _load: (...args: any[]) => any };
const load = Module._load;
let requests: any[] = [];
let respond: (request: any) => any;
let buttons: { text: string; click: () => any }[] = [];
let textChanges: { name: string; change: (value: string) => any }[] = [];
const element = (): any => ({ empty() {}, createDiv: () => element(), createEl: () => element(), setText() {}, remove() {} });
class Setting {
  private name = "";
  setName(name: string) { this.name = name; return this; }
  setDesc() { return this; }
  addButton(callback: (button: any) => void) {
    const action = { text: "", click: () => {} };
    const button: any = { setButtonText: (text: string) => { action.text = text; return button; },
      onClick: (click: () => any) => { action.click = click; return button; }, setDisabled: () => button,
      setCta: () => button, setWarning: () => button };
    callback(button); buttons.push(action); return this;
  }
  addText(callback: (text: any) => void) {
    const text: any = { inputEl: {}, setPlaceholder: () => text, setValue: () => text,
      onChange: (change: (value: string) => any) => { textChanges.push({ name: this.name, change }); return text; } };
    callback(text); return this;
  }
  addToggle(callback: (toggle: any) => void) {
    const toggle: any = { setValue: () => toggle, onChange: () => toggle };
    callback(toggle); return this;
  }
}
const mock = {
  Notice: class {}, PluginSettingTab: class {}, Plugin: class {}, ItemView: class {}, MarkdownView: class {},
  Modal: class { contentEl = element(); close() {} }, Setting,
  normalizePath: (path: string) => path,
  requestUrl: async (request: any) => { requests.push(request); return respond(request); }
};
Module._load = function(name: string, ...args: any[]) {
  return name === "obsidian" ? mock : load.call(this, name, ...args);
};
const { GitService, HttpStatusError } = require("../src/gitService");
const { DEFAULT_SETTINGS, IosGitSyncSettingTab } = require("../src/settings");
const { ShareSelectionModal } = require("../src/shareSelectionModal");
const { CompositeMountsModal } = require("../src/compositeMountsModal");
const { LocalReconciliationModal } = require("../src/localReconciliationModal");
const { DevicePasswordsModal } = require("../src/devicePasswordsModal");
const ObsidiSyncPlugin = require("../src/main").default;
Module._load = load;
(globalThis as any).crypto ??= webcrypto;

const share = { shareId: "s_0123456789abcdef0123456789abcdef", label: "Harmony", capability: "read-write" };
const info = { name: "fixture", version: "0", apiVersion: 1, minClientApiVersion: 1, features: ["shareSyncV2"] };
const ok = (json: any) => ({ status: 200, json, text: "" });
function fixture(overrides: any = {}) {
  requests = [];
  const settings: any = { ...DEFAULT_SETTINGS, serverUrl: "http://localhost:8787", userSlug: "andy",
    vaultSlug: "notes", oidcAccessToken: "synthetic-access", clientId: "fixture-device", initialSyncDone: true,
    serverHead: "old-head", localManifest: [{ path: "grocery.md", sha256: "old-hash", size: 4, mtime: 1 }],
    historySnapshots: [{ sourcePath: "grocery.md", snapshotPath: "recovery/grocery.md", hash: "old-head" }],
    historyVersions: [], ...overrides };
  let saved: any;
  const service = new GitService({ getFiles: () => [] }, settings, async () => {
    saved = JSON.parse(JSON.stringify(settings));
  });
  respond = (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/server/info") return ok(info);
    if (path === "/v1/auth/session") return ok({ user: "andy", subject: "p_andy" });
    if (path === "/v1/auth/config") return ok({ type: "password", passwordConfigured: true });
    if (path === "/v2/shares") return ok([share]);
    if (path.endsWith("/sync-state")) return ok({ ...share, serverHead: "observed-head", branch: "main", apiVersion: 2 });
    throw new Error("Unexpected request: " + path);
  };
  return { service, settings, saved: () => saved };
}
function preserved(settings: any) {
  return JSON.stringify([settings.serverHead, settings.localManifest, settings.initialSyncDone,
    settings.historySnapshots, settings.historyVersions, settings.vaultSlug, settings.clientId]);
}

test("API-1 feature discovery stages destination-bound state without files or registration", async () => {
  const { service, settings, saved } = fixture();
  const old = preserved(settings);
  await service.stageShareSelection(share.shareId);
  assert.equal(preserved(settings), old);
  assert.equal(settings.pendingShareSelection.shareId, share.shareId);
  assert.equal(settings.pendingShareSelection.observedHead, "observed-head");
  assert.equal(settings.pendingShareSelection.syncState.serverHead, null);
  assert.deepEqual(settings.pendingShareSelection.syncState.localManifest, []);
  assert.equal(settings.pendingShareSelection.identity.subject, "p_andy");
  assert.deepEqual(settings.legacyManagementContext, {
    serverUrl: "http://localhost:8787", userSlug: "andy", vaultSlug: "notes"
  });
  assert.equal(saved().pendingShareSelection.status, "reconciliation-required");
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests.some((request) => request.url.endsWith("/sync-state")));
  const restarted = new GitService({}, saved(), async () => {});
  assert.match(restarted.destinationBlocker(), /not enabled/);
});

for (const selectedCapability of ["read", "read-write"]) {
  for (const header of ["allowed", "denied", undefined, "unknown"]) {
    test(`legacy management header ${header} is independent of selected ${selectedCapability}`, async () => {
      const { service, settings } = fixture();
      await service.stageShareSelection(share.shareId);
      const previous = respond;
      const entry = { id: "legacy-id", label: "Legacy Saber", kind: "saber", folder: "Saber/Sync", pdfFolder: "PDFs",
        username: "andy", webdavPath: "/dav/notes/Saber/Sync/", createdAt: "fixture", lastUsedAt: null };
      respond = request => {
        if (request.url.endsWith("/info")) return ok({ ...info, features: [...info.features, "webdavDevicePasswords"] });
        if (request.url.endsWith("/sync-state")) return ok({ ...share, capability: selectedCapability, apiVersion: 2 });
        if (request.url.endsWith("/device-passwords")) return request.url.includes("/v1/")
          ? { ...ok([entry]), headers: header === undefined ? {} : { "X-ObsidiSync-Legacy-Grant-Management": header } }
          : ok([]);
        return previous(request);
      };
      const preservedState = preserved(settings);
      const inventory = await service.legacyCredentialInventory();
      assert.equal(inventory.managementAllowed, header === "allowed");
      assert.deepEqual(inventory.entries, [entry]);
      buttons = [];
      await new DevicePasswordsModal({}, service, settings.serverUrl).onOpen();
      assert.equal(buttons.some(button => button.text === "Create password"), header === "allowed");
      assert.equal(buttons.some(button => button.text === "Revoke"), header === "allowed");
      assert.equal(buttons.some(button => button.text === "Create staged read-write grant"), selectedCapability === "read-write");
      assert.ok(buttons.some(button => button.text === "Create staged read grant"));
      assert.equal(preserved(settings), preservedState);
      assert.ok(requests.filter(request => request.url.includes("/v1/users/")).every(request =>
        request.url.endsWith("/v1/users/andy/vaults/notes/device-passwords") && request.method === "GET"));
    });
  }
}

test("retained legacy routes work after v2 selection without registration or retargeting", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  settings.vaultSlug = "different-display-context";
  const context = JSON.stringify(settings.legacyManagementContext);
  const old = respond;
  requests = [];
  respond = request => request.url.includes("/device-passwords") ? ok(request.method === "GET" ? [] : { id: "synthetic" }) : old(request);
  await service.listDevicePasswords();
  await service.createDevicePassword("Synthetic", "Tablet");
  await service.revokeDevicePassword("synthetic");
  assert.deepEqual(requests.map(request => request.method), ["GET", "POST", "DELETE"]);
  assert.ok(requests.every(request => request.url.includes("/v1/users/andy/vaults/notes/device-passwords")));
  assert.equal(JSON.stringify(settings.legacyManagementContext), context);
  delete settings.legacyManagementContext;
  await assert.rejects(service.listDevicePasswords(), /Original legacy namespace/);
  assert.equal(settings.legacyManagementContext, undefined);
});

test("legacy denial is retained without another namespace attempt or v2 fallback", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const context = JSON.stringify(settings.legacyManagementContext);
  requests = [];
  respond = () => ({ status: 404, json: {}, text: "not found" });
  settings.serverFeatures = ["webdavDevicePasswords"];
  await assert.rejects(service.legacyCredentialInventory(), (error: any) => error.status === 404);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(settings.legacyManagementContext), context);
});

test("legacy inventory cannot deliver an in-flight response after account or context changes", async () => {
  for (const change of ["account", "context"]) {
    const { service, settings } = fixture();
    await service.stageShareSelection(share.shareId);
    requests = [];
    respond = () => {
      if (change === "account") settings.authenticatedIdentity.subject = "different-subject";
      else settings.legacyManagementContext.vaultSlug = "different-vault";
      return { ...ok([]), headers: { "x-obsidisync-legacy-grant-management": "allowed" } };
    };
    await assert.rejects(service.legacyCredentialInventory(), /context changed/);
    assert.equal(requests.length, 1);
  }
});

test("share grant issuance sends explicit read, leaves recovery barriers intact, and never activates", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const previous = respond;
  settings.pendingShareSelection.download = undefined;
  const state = preserved(settings);
  respond = request => {
    if (request.url.endsWith("/sync-state")) return ok({ ...share, capability: "read", apiVersion: 2 });
    if (request.url.endsWith("/device-passwords")) return ok({ id: "staged", password: "synthetic-once", lifecycle: "staged" });
    return previous(request);
  };
  await service.createShareCredential("Synthetic", "Tablet", "read");
  await assert.rejects(service.createShareCredential("Synthetic", "Tablet", "read-write"), /read-only/);
  await assert.rejects(service.revokeShareCredential("staged"), /host-operator/);
  const posts = requests.filter(request => request.method !== "GET");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).capability, "read");
  assert.equal(preserved(settings), state);
  assert.ok(!JSON.stringify(settings).includes("synthetic-once"));
});

test("closing the credential modal removes one-time secrets and stale destination actions fail closed", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const modal = new DevicePasswordsModal({}, service, settings.serverUrl);
  modal.contextKey = service.credentialContextKey();
  settings.pendingShareSelection.shareId = "different-share";
  assert.throws(() => modal.assertContext(), /destination changed/);
  let cleared = false;
  modal.contentEl.empty = () => { cleared = true; };
  modal.onClose();
  assert.equal(cleared, true);
  assert.throws(() => modal.assertContext(), /destination changed/);
});

test("only authorized discovered IDs can be negotiated; labels are not aliases", async () => {
  const { service, settings } = fixture();
  await assert.rejects(service.stageShareSelection("Harmony"), /unavailable/);
  assert.equal(settings.pendingShareSelection, undefined);
  assert.ok(!requests.some((request) => request.url.endsWith("/sync-state")));
});

for (const status of [403, 404]) {
  test("denied negotiation " + status + " retains prior pending state without refresh/fallback", async () => {
    const { service, settings } = fixture({ oidcRefreshToken: "synthetic-refresh" });
    await service.stageShareSelection(share.shareId);
    const previous = JSON.stringify(settings.pendingShareSelection);
    const old = preserved(settings);
    const original = respond;
    requests = [];
    respond = (request) => request.url.endsWith("/sync-state")
      ? { status, json: {}, text: "denied" } : original(request);
    await assert.rejects(service.stageShareSelection(share.shareId),
      (error: any) => error instanceof HttpStatusError && error.status === status);
    assert.equal(JSON.stringify(settings.pendingShareSelection), previous);
    assert.equal(preserved(settings), old);
    assert.equal(settings.lastLoginError, null);
    assert.ok(!requests.some((request) => /refresh|register|\/v1\/users\//.test(request.url)));
  });
}

test("all v1 vault entry points fail before file writes or network while selection is pending", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const old = preserved(settings);
  requests = [];
  for (const operation of [
    () => service.sync(), () => service.forcePushLocal(), () => service.overwriteLocalFromServer("backup"),
    () => service.resolveConflicts([{ path: "grocery.md", kind: "delete" }]),
    () => service.history()
  ]) await assert.rejects(operation(), /not enabled/);
  assert.equal(requests.length, 0);
  assert.equal(preserved(settings), old);
});

test("cancel retains old baseline and permits the original v1 registration/sync workflow", async () => {
  const { service, settings } = fixture({ localManifest: [] });
  await service.stageShareSelection(share.shareId);
  await service.cancelShareSelection();
  assert.equal(service.destinationBlocker(), null);
  const original = respond;
  requests = [];
  respond = (request) => {
    if (request.url.endsWith("/register")) return ok({});
    if (request.url.endsWith("/sync")) return ok({ status: "ok", serverHead: "next-head", files: [], conflicts: [] });
    return original(request);
  };
  await service.sync();
  assert.equal(settings.serverHead, "next-head");
  assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname),
    ["/v1/users/andy/vaults/notes/register", "/v1/users/andy/vaults/notes/sync"]);
});

test("old servers remain writable v1 and do not receive share requests", async () => {
  const { service } = fixture({ localManifest: [] });
  respond = (request) => request.url.endsWith("/info") ? ok({ ...info, features: undefined })
    : request.url.endsWith("/register") ? ok({})
    : request.url.endsWith("/sync") ? ok({ status: "ok", serverHead: null, files: [], conflicts: [] })
    : assert.fail("unexpected old-server request");
  await assert.rejects(service.discoverShares(), /does not advertise/);
  await service.sync();
  assert.ok(!requests.some((request) => request.url.includes("/v2/")));
});

for (const field of ["serverUrl", "userSlug", "vaultSlug"]) {
  test("changing " + field + " cannot reuse a legacy baseline", async () => {
    const { service, settings } = fixture();
    const old = preserved(settings);
    settings[field] = field === "serverUrl" ? "http://localhost:9999" : "different";
    await assert.rejects(service.sync(), /destination or account changed/);
    assert.equal(requests.length, 0);
    assert.equal(settings.serverHead, "old-head");
    if (field !== "vaultSlug") assert.equal(preserved(settings), old);
  });
}

test("account switch preserves original legacy context and blocks old baseline reuse", async () => {
  const { service, settings } = fixture();
  await service.discoverShares();
  const old = preserved(settings);
  respond = () => ok({ user: "liz", subject: "p_liz", accessToken: "synthetic-liz", refreshToken: "synthetic-refresh", expiresIn: 3600 });
  await service.loginPassword("liz", "synthetic-password", false);
  assert.equal(settings.userSlug, "liz");
  assert.equal(settings.legacyManagementContext.userSlug, "andy");
  assert.equal(settings.legacySyncBinding.subject, "p_andy");
  assert.equal(preserved(settings), old);
  assert.match(service.destinationBlocker(), /account changed/);
});

test("same-namespace different subject cannot reuse the original account baseline", async () => {
  const { service, settings } = fixture();
  await service.discoverShares();
  const original = respond;
  respond = (request) => request.url.endsWith("/session")
    ? ok({ user: "andy", subject: "other-subject" }) : original(request);
  await service.loadAuthenticatedUser();
  assert.equal(settings.legacySyncBinding.subject, "p_andy");
  assert.match(service.destinationBlocker(), /account changed/);
});

test("legacy issuer-less refresh rejection and fresh login preserve pending selection and recovery", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const old = preserved(settings);
  const pending = JSON.stringify(settings.pendingShareSelection);
  settings.oidcRefreshToken = "synthetic-issuer-less-refresh";
  respond = () => ({ status: 401, json: { error: "invalid_grant" }, text: "login again" });
  assert.equal(await service.refreshOidcAccessToken(), false);
  respond = () => ok({ user: "andy", subject: "p_andy", accessToken: "synthetic-new", refreshToken: "synthetic-new-refresh", expiresIn: 3600 });
  await service.loginPassword("andy", "synthetic-password", false);
  assert.equal(preserved(settings), old);
  assert.equal(JSON.stringify(settings.pendingShareSelection), pending);
  assert.match(service.destinationBlocker(), /not enabled/);
});

test("explicit development session is discovered as returned by server, without local/OIDC aliasing", async () => {
  const { service, settings } = fixture({ userSlug: "dev" });
  const original = respond;
  respond = (request) => request.url.endsWith("/session") ? ok({ user: "dev", subject: "dev" })
    : request.url.endsWith("/config") ? ok({ type: "token" }) : original(request);
  await service.stageShareSelection(share.shareId);
  assert.equal(settings.pendingShareSelection.authentication, "token");
  assert.equal(settings.pendingShareSelection.identity.subject, "dev");
  assert.equal(settings.legacyManagementContext.userSlug, "dev");
});

test("production rejection of development token cannot stage a share or fall back", async () => {
  const { service, settings } = fixture();
  const original = respond;
  respond = (request) => request.url.endsWith("/session")
    ? { status: 401, json: {}, text: "unauthorized" } : original(request);
  await assert.rejects(service.stageShareSelection(share.shareId), /Login expired/);
  assert.equal(settings.pendingShareSelection, undefined);
  assert.ok(!requests.some((request) => request.url.includes("/v1/users/") || request.url.includes("/v2/")));
});

test("cancellation while negotiation is in flight cannot resurrect a pending selection", async () => {
  const { service, settings } = fixture();
  const original = respond;
  let finish: (response: any) => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  respond = (request) => {
    if (!request.url.endsWith("/sync-state")) return original(request);
    entered();
    return new Promise((resolve) => { finish = resolve; });
  };
  const selection = service.stageShareSelection(share.shareId);
  await waiting;
  await service.cancelShareSelection();
  finish(ok({ ...share, serverHead: null, apiVersion: 2 }));
  await assert.rejects(selection, /context changed/);
  assert.equal(settings.pendingShareSelection, null);
});

test("unknown negotiation capability cannot enable synchronization", async () => {
  const { service, settings } = fixture();
  const original = respond;
  respond = (request) => request.url.endsWith("/sync-state")
    ? ok({ ...share, capability: "admin", serverHead: null, apiVersion: 2 }) : original(request);
  await assert.rejects(service.stageShareSelection(share.shareId), /invalid share negotiation/);
  assert.equal(settings.pendingShareSelection, undefined);
});

test("manual/startup/timer shared entry and both reset controls preserve pending state", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  const old = preserved(settings);
  requests = [];
  const plugin: any = Object.create(ObsidiSyncPlugin.prototype);
  plugin.gitService = service;
  plugin.settings = settings;
  plugin.saveSettings = async () => assert.fail("reset must not save changed state");
  await plugin.syncNow();
  await assert.rejects(plugin.resetLocalSyncState(), /not enabled/);
  assert.equal(requests.length, 0);
  plugin.onLoginStatusChange = () => () => {};
  plugin.refreshConnectionStatus = async () => info;
  const tab: any = new IosGitSyncSettingTab({}, plugin);
  tab.containerEl = element();
  buttons = [];
  tab.display();
  await buttons.find((button) => button.text === "Reset")!.click();
  assert.equal(preserved(settings), old);
});

test("share chooser selects a discovered ID and can explicitly cancel saved selection", async () => {
  const { service, settings, saved } = fixture();
  buttons = [];
  const modal = new ShareSelectionModal({}, service, settings);
  await modal.onOpen();
  await buttons.find((button) => button.text === "Select")!.click();
  assert.equal(saved().pendingShareSelection.shareId, share.shareId);
  buttons = [];
  await new ShareSelectionModal({}, service, settings).onOpen();
  await buttons.find((button) => button.text === "Cancel pending selection")!.click();
  assert.equal(saved().pendingShareSelection, null);
});

test("a 403 after successful refresh remains a capability error", async () => {
  const { service, settings } = fixture({ oidcRefreshToken: "synthetic-refresh" });
  let sessions = 0;
  respond = (request) => {
    if (request.url.endsWith("/refresh")) return ok({ user: "andy", subject: "p_andy", accessToken: "renewed",
      refreshToken: "renewed-refresh", expiresIn: 3600 });
    sessions++;
    return { status: sessions === 1 ? 401 : 403, json: {}, text: "capability denied" };
  };
  await assert.rejects(service.getJson("/v1/auth/session"), (error: any) => error.status === 403);
  assert.equal(settings.lastLoginError, null);
});

test("manual token replacement requires verified identity before reusing a known baseline", async () => {
  const { service, settings } = fixture();
  await service.discoverShares();
  const plugin: any = { settings, onLoginStatusChange: () => () => {},
    refreshConnectionStatus: async () => info, saveSettings: async () => {} };
  const tab: any = new IosGitSyncSettingTab({}, plugin);
  tab.containerEl = element();
  textChanges = [];
  tab.display();
  await textChanges.find((entry) => entry.name === "Access token")!.change("synthetic-rotated-token");
  assert.equal(settings.authenticatedIdentity, undefined);
  assert.match(service.destinationBlocker(), /account changed/);
  await service.loadAuthenticatedUser();
  assert.equal(service.destinationBlocker(), null);
});

test("read capability is negotiated without enabling even download-only v2 sync", async () => {
  const { service, settings } = fixture();
  const original = respond;
  respond = (request) => request.url.endsWith("/sync-state")
    ? ok({ ...share, capability: "read", serverHead: null, apiVersion: 2 }) : original(request);
  await service.stageShareSelection(share.shareId);
  assert.equal(settings.pendingShareSelection.capability, "read");
  assert.match(service.destinationBlocker(), /not enabled/);
});

test("initial share download UI requires explicit consent and active chooser cannot retarget", async () => {
  const { service, settings } = fixture();
  await service.stageShareSelection(share.shareId);
  let initializations = 0;
  service.initializeShareDownload = async () => { initializations++; };
  (globalThis as any).window = { confirm: () => false };
  buttons = [];
  await new ShareSelectionModal({}, service, settings).onOpen();
  const download = buttons.find((button) => button.text === "Back up and download share")!;
  await download.click(); assert.equal(initializations, 0);
  (globalThis as any).window.confirm = () => true;
  await download.click(); assert.equal(initializations, 1);
  settings.activeShare = { ...share, download: { reconciliation: [] } };
  buttons = [];
  await new ShareSelectionModal({}, service, settings).onOpen();
  assert.equal(buttons.length, 0);
});

test("local reconciliation UI offers only local choices and confirms remote replacement", async () => {
  const calls: string[] = [];
  const service = {
    canWriteSelectedShare: () => false,
    localReconciliations: () => [{ path: "a.md", reason: "local edit", remote: { op: "delete" }, remoteHead: "h2" }],
    keepLocalReconciliation: async (path: string) => { calls.push(`keep:${path}`); },
    useRemoteReconciliation: async (path: string) => { calls.push(`remote:${path}`); }
  };
  (globalThis as any).window = { confirm: () => false };
  buttons = []; new LocalReconciliationModal({}, service).onOpen();
  assert.deepEqual(buttons.map((button) => button.text), ["Keep local (upload blocked)", "Back up and use remote"]);
  await buttons[0].click(); assert.deepEqual(calls, ["keep:a.md"]);
  const remote = buttons.find((button) => button.text === "Back up and use remote")!;
  await remote.click(); assert.equal(calls.length, 1);
  (globalThis as any).window.confirm = () => true;
  await remote.click(); assert.deepEqual(calls, ["keep:a.md", "remote:a.md"]);
});

test("writable reconciliation UI requires explicit confirmation for uploading a blocked local choice", async () => {
  const calls: string[] = [];
  const service = {
    canWriteSelectedShare: () => true,
    localReconciliations: () => [{ path: "a.md", reason: "local edit", remote: { op: "delete" }, remoteHead: "h2" }],
    uploadLocalReconciliation: async (path: string) => { calls.push(path); }
  };
  (globalThis as any).window = { confirm: () => false };
  buttons = []; new LocalReconciliationModal({}, service).onOpen();
  const upload = buttons.find((button) => button.text === "Back up and upload local choice")!;
  assert.ok(upload); await upload.click(); assert.deepEqual(calls, []);
  (globalThis as any).window.confirm = () => true;
  await upload.click(); assert.deepEqual(calls, ["a.md"]);
});

test("startup metadata migration retains legacy recovery records while selection is pending or active", async () => {
  const { service, settings } = fixture();
  settings.historyVersions = [{ sourcePath: "grocery.md", hash: "legacy-head", name: "Retained version" }];
  await service.stageShareSelection(share.shareId);
  const old = JSON.stringify(settings.historyVersions);
  const plugin: any = Object.create(ObsidiSyncPlugin.prototype);
  plugin.settings = settings; plugin.gitService = service;
  plugin.saveSettings = async () => assert.fail("Migration must not discard retained metadata");
  requests = [];
  await plugin.migrateLocalHistoryVersions();
  settings.activeShare = { ...share, download: { reconciliation: [] } };
  settings.pendingShareSelection = null;
  await plugin.migrateLocalHistoryVersions();
  assert.equal(JSON.stringify(settings.historyVersions), old);
  assert.equal(requests.length, 0);
});

test("overlapping plugin saves snapshot state and cannot overwrite a later recovery journal out of order", async () => {
  const plugin: any = Object.create(ObsidiSyncPlugin.prototype);
  plugin.settings = { marker: "before journal" }; plugin.settingsSave = Promise.resolve();
  const writes: any[] = [];
  let release: () => void = () => {};
  plugin.saveData = async (snapshot: any) => {
    writes.push(snapshot);
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  };
  const first = plugin.saveSettings();
  await new Promise((resolve) => setImmediate(resolve));
  plugin.settings.marker = "journal persisted";
  const second = plugin.saveSettings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ marker: "before journal" }]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(writes, [{ marker: "before journal" }, { marker: "journal persisted" }]);
});

test("a failed plugin save rejects its caller without poisoning subsequent durable saves", async () => {
  const plugin: any = Object.create(ObsidiSyncPlugin.prototype);
  plugin.settings = { marker: "intent" }; plugin.settingsSave = Promise.resolve();
  plugin.saveData = async () => { throw new Error("synthetic persistence failure"); };
  await assert.rejects(plugin.saveSettings(), /persistence failure/);
  let written: any;
  plugin.saveData = async (snapshot: any) => { written = snapshot; };
  plugin.settings.marker = "recovered"; await plugin.saveSettings();
  assert.deepEqual(written, { marker: "recovered" });
});

test("composite chooser separates mount selection from explicit per-mount download consent", async () => {
  buttons = []; textChanges = [];
  let mounts: any[] = [];
  let downloads = 0;
  const service = {
    compositeMounts: () => mounts, discoverShares: async () => [share],
    addCompositeMount: async (shareId: string, localPrefix: string) => {
      assert.equal(shareId, share.shareId); assert.equal(localPrefix, "Personal");
      mounts = [{ ...share, localPrefix, mountId: "mount-1", initialized: false, barriers: [],
        download: { reconciliation: [] } }];
    },
    initializeCompositeMount: async (mountId: string) => {
      assert.equal(mountId, "mount-1"); downloads++; mounts[0].initialized = true;
    }
  };
  const modal = new CompositeMountsModal({}, service);
  await modal.onOpen();
  await buttons.find((button) => button.text === "Add mount")!.click();
  assert.equal(downloads, 0);
  (globalThis as any).window = { confirm: () => false };
  await buttons.find((button) => button.text === "Back up and download")!.click();
  assert.equal(downloads, 0);
  (globalThis as any).window.confirm = () => true;
  await buttons.find((button) => button.text === "Back up and download")!.click();
  assert.equal(downloads, 1);
  assert.ok(buttons.some((button) => button.text === "Retry downloads"));
  assert.ok(!buttons.some((button) => /upload|Enable writes/.test(button.text)));
});

test("startup refuses corrupt composite settings before scheduling or falling back to v1", async () => {
  const plugin: any = Object.create(ObsidiSyncPlugin.prototype);
  plugin.loadData = async () => ({ composite: { version: 99 } });
  await assert.rejects(plugin.loadSettings(), /Invalid composite/);
  assert.equal(plugin.settings.composite.version, 99, "corrupt evidence is not reset");
});
