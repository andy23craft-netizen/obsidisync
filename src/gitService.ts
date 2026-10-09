import { Notice, requestUrl, RequestUrlResponse, Vault } from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64";
import { diffManifests } from "./manifest";
import {
  ClientChange,
  CreateDevicePasswordRequest,
  FileContentMode,
  CreatedDevicePassword,
  DevicePasswordEntry,
  ShareCredentialEntry,
  CreatedShareCredential,
  DeviceEntry,
  DeviceVersionEntry,
  HistoryEntry,
  RegisterRequest,
  RegisterResponse,
  ResolveRequest,
  ServerFileChange,
  SyncConflict,
  SyncRequest,
  SyncResponse,
  ManifestEntry,
  ServerInfoResponse,
  ShareEntry,
  ShareSyncState,
  UploadChunkResponse,
  UploadCompleteResponse,
  UploadInitRequest,
  UploadInitResponse,
  VersionFileResponse,
  VersionMetadataRequest
} from "./protocol";
import { devicePasswordsAvailabilityMessage } from "./devicePasswords";
import { createClientId, getDeviceName } from "./runtime";
import {
  describeDownloadProgress,
  hashesByPath,
  removeManifestEntry,
  serverSupportsFileReferences,
  upsertManifestEntry
} from "./serverFiles";
import { IosGitSyncSettings } from "./settings";
import { assertGitBranch, assertNamespaceSlug, assertSecureHttpUrl } from "./security";
import { ServerUpsert, sha256Hex, VaultState } from "./vaultState";
import { captureLegacyContext, serverIdentity, syncDestinationBlocker } from "./shareSelection";
import { ActiveShare, LocalReconciliation, ShareReconciler, sharePathSupported, sameFile } from "./shareReconciliation";
import type { PendingShareSelection, LegacyManagementContext } from "./shareSelection";

type SaveSettings = () => Promise<void>;
type ConflictNoticeHandler = (conflicts: SyncConflict[]) => void;

export type ConflictResolution =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "binary"; contentBase64: string }
  | { path: string; kind: "current" }
  | { path: string; kind: "delete" };
type SyncStateListener = (running: boolean) => void;
type LoginStatusListener = (status: LoginStatus) => void;
type SyncBlocker = () => string | null;
const MAIN_BRANCH = "main";
const CLIENT_API_VERSION = 1;
const OIDC_REFRESH_WINDOW_MS = 60_000;
const OIDC_MAINTENANCE_REFRESH_WINDOW_MS = 60 * 60 * 1000;
const OIDC_MAINTENANCE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_PROGRESS_SAVE_EVERY = 10;
const DOWNLOAD_PROGRESS_NOTICE_MIN_FILES = 5;

export interface OidcDeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface OidcDiscovery {
  device_authorization_endpoint: string;
  token_endpoint: string;
}

interface OidcTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export type ServerAuthConfig =
  | { type: "password"; passwordConfigured: boolean; setupTokenRequired?: boolean;
      accountProvisioning?: "host-local"; loginAvailable?: boolean }
  | { type: "oidc"; issuer: string; clientId: string; scope: string; audience?: string | null }
  | { type: "token" };

interface PasswordLoginResponse {
  user: string;
  subject?: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

interface ServerSessionResponse {
  user: string;
  subject: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

interface AuthSessionResponse {
  user: string;
  subject: string;
}

export interface LoginStatus {
  state: "logged-in" | "not-logged-in" | "failed";
  title: string;
  detail: string;
}

export class GitService {
  private running = false;
  private syncQueued = false;
  private syncStateListeners = new Set<SyncStateListener>();
  private loginStatusListeners = new Set<LoginStatusListener>();
  private oidcDiscoveryCache: OidcDiscovery | null = null;
  private oidcLoginConfig: Extract<ServerAuthConfig, { type: "oidc" }> | null = null;
  private oidcLoginServerUrl: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private selectionRevision = 0;

  constructor(
    private readonly vault: Vault,
    private settings: IosGitSyncSettings,
    private readonly saveSettings: SaveSettings,
    private readonly onConflictNotice?: ConflictNoticeHandler,
    private readonly syncBlocker?: SyncBlocker
  ) { captureLegacyContext(this.settings); }

  destinationBlocker(): string | null {
    return syncDestinationBlocker(this.settings);
  }

  private rememberAuthenticatedUser(session: AuthSessionResponse | PasswordLoginResponse): void {
    captureLegacyContext(this.settings);
    if (session.subject) {
      this.settings.authenticatedIdentity = {
        serverUrl: serverIdentity(this.settings.serverUrl), user: session.user, subject: session.subject
      };
      const binding = this.settings.legacySyncBinding;
      if (binding && !binding.subject && binding.serverUrl === serverIdentity(this.settings.serverUrl) &&
          binding.userSlug === session.user) binding.subject = session.subject;
    }
    this.settings.userSlug = session.user;
  }

  async discoverShares(): Promise<ShareEntry[]> {
    const serverUrl = serverIdentity(this.settings.serverUrl);
    const info = await this.checkServerCompatibility();
    if (!info.features?.includes("shareSyncV2")) throw new Error("This server does not advertise shareSyncV2. Existing v1 synchronization remains available.");
    const session = await this.getJson<AuthSessionResponse>("/v1/auth/session");
    if (!session.subject || !session.user || serverIdentity(this.settings.serverUrl) !== serverUrl) {
      throw new Error("Server or authenticated session changed during share discovery. Try again.");
    }
    this.rememberAuthenticatedUser(session);
    await this.saveSettings();
    const shares = await this.getJson<ShareEntry[]>("/v2/shares");
    if (!Array.isArray(shares) || shares.some((share) => !validShare(share))) {
      throw new Error("Server returned an invalid share list");
    }
    if (serverIdentity(this.settings.serverUrl) !== serverUrl) throw new Error("Server changed during share discovery");
    return shares;
  }

  async stageShareSelection(shareId: string): Promise<void> {
    if (this.running) throw new Error("Wait for synchronization to finish before selecting a share");
    if (this.settings.activeShare || this.settings.pendingShareSelection?.download) {
      throw new Error("Existing share reconciliation state must be retained. Use a separate local vault for another share.");
    }
    const revision = ++this.selectionRevision;
    const shares = await this.discoverShares();
    const share = shares.find((entry) => entry.shareId === shareId);
    if (!share) throw new Error("Share is unavailable or inaccessible");
    const identity = { ...this.settings.authenticatedIdentity! };
    const token = this.settings.oidcAccessToken;
    const config = await this.authConfig();
    if (!["password", "oidc", "token"].includes(config.type)) throw new Error("Invalid authentication configuration");
    const state = await this.getJson<ShareSyncState>(`/v2/shares/${encodeURIComponent(share.shareId)}/sync-state`);
    if (this.running || revision !== this.selectionRevision || token !== this.settings.oidcAccessToken ||
        serverIdentity(this.settings.serverUrl) !== identity.serverUrl ||
        JSON.stringify(this.settings.authenticatedIdentity) !== JSON.stringify(identity) || this.settings.userSlug !== identity.user) {
      throw new Error("Selection context changed. Try again after synchronization/login finishes.");
    }
    if (state.shareId !== share.shareId || !["read", "read-write"].includes(state.capability) ||
        state.apiVersion !== 2 || !(state.serverHead === null || typeof state.serverHead === "string")) {
      throw new Error("Server returned invalid share negotiation");
    }
    this.settings.pendingShareSelection = {
      shareId: share.shareId, label: share.label, capability: state.capability, serverUrl: identity.serverUrl, identity,
      authentication: config.type === "oidc" ? `oidc:${config.issuer}` : config.type,
      status: "reconciliation-required", observedHead: state.serverHead,
      syncState: { serverHead: null, localManifest: [], initialSyncDone: false }
    };
    await this.saveSettings();
  }

  async cancelShareSelection(): Promise<void> {
    if (this.running) throw new Error("Wait for synchronization to finish before cancelling a selection");
    if (this.settings.pendingShareSelection?.download) throw new Error("Initial download has started. Resume reconciliation; cancellation cannot safely restore v1 files.");
    ++this.selectionRevision;
    this.settings.pendingShareSelection = null;
    await this.saveSettings();
  }

  synchronizedManifest(): ManifestEntry[] {
    return this.settings.activeShare?.download.baseline ?? this.settings.localManifest;
  }

  hasSelectedShare(): boolean { return Boolean(this.settings.activeShare); }

  canWriteSelectedShare(): boolean {
    if (this.settings.pendingShareSelection) return false;
    const selected = this.settings.activeShare;
    return !selected || (selected.status === "writable" && selected.capability === "read-write");
  }

  lastSynchronizedAt(): string | null {
    return this.settings.activeShare?.download.lastDownloadedAt ?? (this.settings.activeShare ? null : this.settings.lastSyncedAt);
  }

  shareDownloadStatus(): string | null {
    const selected = this.settings.activeShare;
    return selected ? `${selected.capability}, ${selected.status}; ${selected.download.reconciliation.length} local barrier(s)` : null;
  }

  /** Explicit opt-in after initial download. Existing preservation records remain upload barriers. */
  async enableShareWrites(): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.settings.activeShare;
      if (!selected || !selected.download.initial.complete) throw new Error("Finish initial reconciliation first");
      await this.negotiateShare(selected);
      if (selected.capability !== "read-write") throw new Error("Share is read-only");
      await this.downloadSnapshot(selected); // Recover applying journals before enabling any write path.
      await this.recoverShareWrite(selected);
      selected.status = "writable";
      await this.saveSettings();
    });
  }

  localReconciliations(): LocalReconciliation[] {
    return this.settings.activeShare?.download.reconciliation ?? this.settings.pendingShareSelection?.download?.reconciliation ?? [];
  }

  /** Entry from explicit download/overwrite consent only. No background call creates this recovery state. */
  async initializeShareDownload(): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.settings.pendingShareSelection;
      if (!selected) throw new Error("Select a share before initial reconciliation");
      await this.negotiateShare(selected);
      this.assertShareContext(selected);
      const vaultState = new VaultState(this.vault);
      if (!selected.download) {
        selected.download = { observedHead: null, baseline: [], reconciliation: [],
          initial: { backupFolder: "", appliedPaths: [], complete: false } };
        await this.saveSettings();
      }
      if (!selected.download.initial.backupManifest) {
        // A failed/interrupted backup is retained, but never reused as proof of a completed backup.
        selected.download.initial.backupFolder = this.recoveryFolder();
        await this.saveSettings();
        selected.download.initial.backupManifest = await vaultState.verifiedBackup(
          selected.download.initial.backupFolder, vaultState.paths().filter(sharePathSupported));
        await this.saveSettings();
      }
      await this.downloadSnapshot(selected, true);
      this.assertShareContext(selected);
      selected.download.lastDownloadedAt = new Date().toISOString();
      this.settings.lastSyncCompletedAt = selected.download.lastDownloadedAt;
      const { syncState: _oldPendingState, status: _status, observedHead: _observation, ...destination } = selected;
      this.settings.activeShare = { ...destination, status: "download-only", download: selected.download };
      this.settings.pendingShareSelection = null;
      await this.saveSettings();
      new Notice(`Share download initialized; ${selected.download.reconciliation.length} file(s) require reconciliation. V2 uploads remain disabled.`);
    });
  }

  private recoveryFolder(): string {
    return `.obsidian-git-sync/backups/${new Date().toISOString().replace(/[:.]/g, "-")}-${createClientId()}`;
  }

  private assertShareContext(selected: PendingShareSelection | ActiveShare): void {
    const current = this.settings.activeShare ?? this.settings.pendingShareSelection;
    const identity = this.settings.authenticatedIdentity;
    if (current !== selected || serverIdentity(this.settings.serverUrl) !== selected.serverUrl ||
        identity?.serverUrl !== selected.serverUrl || identity?.subject !== selected.identity.subject ||
        identity?.user !== selected.identity.user || this.settings.userSlug !== selected.identity.user) {
      throw new Error("Share destination or account changed. Reconciliation state is retained; restore the selected identity.");
    }
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    if (!this.settings.oidcAccessToken || /\s/.test(this.settings.oidcAccessToken)) throw new Error("Log in before share downloads");
  }

  private sharePath(selected: PendingShareSelection | ActiveShare): string {
    this.assertShareContext(selected);
    return `/v2/shares/${encodeURIComponent(selected.shareId)}`;
  }

  private async readVaultPath(): Promise<string> {
    if (this.settings.activeShare) {
      const selected = this.settings.activeShare;
      await this.negotiateShare(selected);
      return this.sharePath(selected);
    }
    this.requireConfigured();
    return this.vaultPath();
  }

  private async negotiateShare(selected: PendingShareSelection | ActiveShare): Promise<void> {
    this.assertShareContext(selected);
    const info = await this.checkServerCompatibility();
    if (!info.features?.includes("shareSyncV2")) throw new Error("Selected server no longer advertises shareSyncV2; no v1 fallback");
    const session = await this.getJson<AuthSessionResponse>("/v1/auth/session");
    this.assertShareContext(selected);
    if (session.subject !== selected.identity.subject || session.user !== selected.identity.user) {
      throw new Error("Authenticated account differs from selected share state");
    }
    const config = await this.authConfig();
    const authentication = config.type === "oidc" ? `oidc:${config.issuer}` : config.type;
    if (authentication !== selected.authentication) throw new Error("Authentication configuration changed; selected recovery state is retained");
    const state = await this.getJson<ShareSyncState>(`${this.sharePath(selected)}/sync-state`);
    this.assertShareContext(selected);
    if (state.shareId !== selected.shareId || state.apiVersion !== 2 ||
        !["read", "read-write"].includes(state.capability)) throw new Error("Invalid share negotiation");
    const downgraded = selected.capability === "read-write" && state.capability === "read";
    selected.capability = state.capability;
    await this.saveSettings();
    if (downgraded && selected.download) await new ShareReconciler(new VaultState(this.vault), selected.download,
      this.saveSettings, () => this.assertShareContext(selected)).preserveLocalChanges();
  }

  private async requireShareWrite(selected: PendingShareSelection | ActiveShare): Promise<void> {
    await this.negotiateShare(selected);
    if (selected.capability !== "read-write") throw new Error("Share is read-only; local edits and recovery state retained");
  }

  private async shareWrite<T>(selected: PendingShareSelection | ActiveShare, path: string, body: unknown): Promise<T> {
    await this.requireShareWrite(selected);
    try { return await this.postJson<T>(`${this.sharePath(selected)}${path}`, body); }
    catch (error) {
      if (error instanceof HttpStatusError && error.status === 403) {
        selected.capability = "read";
        await this.saveSettings();
        if (selected.download) await new ShareReconciler(new VaultState(this.vault), selected.download,
          this.saveSettings, () => this.assertShareContext(selected)).preserveLocalChanges();
      }
      throw error;
    }
  }

  /** Recover unknown outcomes using remote contents, never by resending consumed upload IDs. */
  private async recoverShareWrite(selected: ActiveShare): Promise<void> {
    const state = selected.download;
    const writing = state.writing;
    if (!writing) return;
    const response = await this.shareSnapshot(selected);
    const pending = await this.readShareConflicts(selected, writing.entries.map((entry) => entry.path));
    for (const sent of writing.entries) {
      if (pending.some((file) => file.path === sent.path)) continue; // Server conflict is already a durable write barrier.
      const remote = response.files.find((file) => file.path === sent.path) ?? { path: sent.path, op: "delete" as const };
      const matches = remote.op === "delete" ? sent.entry === null : sent.entry?.sha256 === remote.sha256;
      if (writing.stage !== "staging" && matches) {
        state.baseline = state.baseline.filter((entry) => entry.path !== sent.path);
        if (sent.entry) state.baseline.push(sent.entry);
      } else if (!state.reconciliation.some((entry) => entry.path === sent.path)) {
        state.reconciliation.push({ path: sent.path, baseline: state.baseline.find((entry) => entry.path === sent.path) ?? null,
          remote, remoteHead: response.serverHead, reason: "Interrupted write has an unconfirmed outcome; explicit reconciliation required",
          uploadBlocked: true });
      }
    }
    delete state.writing;
    await this.saveSettings();
    await this.applyShareSnapshot(selected, response);
  }

  private async readShareConflicts(selected: ActiveShare, explicitlyHandled: string[] = []): Promise<SyncConflict[]> {
    const pending = await this.getJson<SyncConflict[]>(`${this.sharePath(selected)}/conflicts?clientId=${encodeURIComponent(this.settings.clientId)}`);
    if (!Array.isArray(pending) || pending.some((file) => typeof file.path !== "string" || typeof file.reason !== "string")) {
      throw new Error("Invalid server conflict list");
    }
    for (const previous of selected.download.serverConflicts ?? []) {
      if (pending.some((file) => file.path === previous.path) || explicitlyHandled.includes(previous.path) ||
          selected.download.reconciliation.some((file) => file.path === previous.path)) continue;
      const baseline = selected.download.baseline.find((entry) => entry.path === previous.path) ?? null;
      selected.download.reconciliation.push({ path: previous.path, baseline, remote: baseline
        ? { path: previous.path, op: "upsert", sha256: baseline.sha256 } : { path: previous.path, op: "delete" },
        remoteHead: selected.download.observedHead, reason: "Server conflict was cleared elsewhere; reconcile retained local contents",
        uploadBlocked: true });
    }
    selected.download.serverConflicts = pending;
    await this.saveSettings();
    return pending;
  }

  private async shareSnapshot(selected: PendingShareSelection | ActiveShare): Promise<SyncResponse> {
    const response = await this.postJson<SyncResponse>(`${this.sharePath(selected)}/sync`, {
      baseHead: null, clientId: this.settings.clientId, deviceName: this.deviceName(),
      changes: [], clientManifest: [], fileContent: this.fileContentMode()
    } satisfies SyncRequest);
    if (response.status !== "ok" || !Array.isArray(response.files) || !Array.isArray(response.conflicts) ||
        response.conflicts.length || !(response.serverHead === null || typeof response.serverHead === "string") ||
        (response.files.length && !response.serverHead)) throw new Error("Invalid read-only sync response");
    return response;
  }

  private async applyShareSnapshot(selected: PendingShareSelection | ActiveShare, response: SyncResponse, initial = false): Promise<void> {
    if (!selected.download) throw new Error("Missing explicit initial reconciliation");
    await new ShareReconciler(new VaultState(this.vault), selected.download, this.saveSettings,
      () => this.assertShareContext(selected)).applySnapshot(response.files, response.serverHead,
      (file) => this.downloadShareFile(selected, file, response.serverHead), initial);
  }

  private async downloadSnapshot(selected: PendingShareSelection | ActiveShare, initial = false): Promise<void> {
    await this.applyShareSnapshot(selected, await this.shareSnapshot(selected), initial);
  }

  private async performShareSync(): Promise<SyncConflict[]> {
    const selected = this.settings.activeShare!;
    await this.negotiateShare(selected);
    // Recover application and network journals before collecting a single new upload.
    if (selected.download.applying) await this.downloadSnapshot(selected);
    await this.recoverShareWrite(selected);
    if (selected.status !== "writable" || selected.capability !== "read-write") {
      await this.performShareDownload(); return [];
    }
    await this.readShareConflicts(selected);
    const vault = new VaultState(this.vault);
    const paths = new Set([...vault.paths(), ...selected.download.baseline.map((entry) => entry.path)]);
    const captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }> = [];
    for (const path of paths) {
      if (!sharePathSupported(path) || selected.download.reconciliation.some((entry) => entry.path === path) ||
          selected.download.serverConflicts?.some((entry) => entry.path === path)) continue;
      let file: { entry: ManifestEntry | null; bytes?: ArrayBuffer };
      try { file = await vault.capture(path); }
      catch (error) {
        const baseline = selected.download.baseline.find((entry) => entry.path === path) ?? null;
        selected.download.reconciliation.push({ path, baseline, remote: baseline
          ? { path, op: "upsert", sha256: baseline.sha256 } : { path, op: "delete" },
          remoteHead: selected.download.observedHead, reason: `Local upload state uncertain: ${String(error)}`, uploadBlocked: true });
        await this.saveSettings();
        continue;
      }
      if (!sameFile(file.entry, selected.download.baseline.find((entry) => entry.path === path) ?? null)) captured.push({ path, entry: file.entry });
    }
    if (captured.length) await this.submitShareChanges(selected, captured, selected.download.observedHead);
    await this.downloadSnapshot(selected);
    selected.download.lastDownloadedAt = new Date().toISOString();
    this.settings.lastSyncCompletedAt = selected.download.lastDownloadedAt;
    await this.saveSettings();
    const conflicts = selected.download.serverConflicts ?? [];
    if (conflicts.length) this.showConflictNotice(conflicts);
    else new Notice(`Share sync complete: ${captured.length} local change(s); ${selected.download.reconciliation.length} local barrier(s)`);
    return conflicts;
  }

  private async submitShareChanges(selected: ActiveShare,
    captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }>, baseHead: string | null,
    resolve = false): Promise<void> {
    const state = selected.download;
    if (state.writing || state.applying) throw new Error("Recover interrupted work before writing");
    state.writing = { stage: "staging", entries: captured.map(({ path, entry }) => ({ path, entry })) };
    await this.saveSettings();
    const changes: ClientChange[] = [];
    for (const file of captured) {
      if (file.entry) {
        // Hold at most one staged file's bytes. A reread must still match the journaled capture.
        const bytes = file.bytes ?? (await new VaultState(this.vault).capture(file.path)).bytes;
        if (!bytes || await sha256Hex(bytes) !== file.entry.sha256) throw new Error(`Local file changed before staging: ${file.path}`);
        const uploadId = await this.uploadShareBuffer(selected, file.path, bytes, file.entry);
        changes.push({ path: file.path, op: "upsert", uploadId, sha256: file.entry.sha256, mtime: file.entry.mtime });
      } else changes.push({ path: file.path, op: "delete" });
    }
    state.writing.stage = "submitted";
    await this.saveSettings();
    const response = resolve
      ? await this.shareWrite<SyncResponse>(selected, "/resolve", {
        clientId: this.settings.clientId, deviceName: this.deviceName(), fileContent: this.fileContentMode(),
        files: changes.map((change) => change.op === "delete" ? { path: change.path, delete: true }
          : { path: change.path, uploadId: change.uploadId }) } satisfies ResolveRequest)
      : await this.shareWrite<SyncResponse>(selected, "/sync", {
        baseHead, clientId: this.settings.clientId, deviceName: this.deviceName(), changes,
        clientManifest: state.baseline, fileContent: this.fileContentMode() } satisfies SyncRequest);
    if (!["ok", "conflict"].includes(response.status) || !Array.isArray(response.conflicts) ||
        !Array.isArray(response.files)) throw new Error("Invalid write response; journal retained");
    const unresolved = resolve ? (state.serverConflicts ?? []).filter((conflict) =>
      !captured.some((file) => file.path === conflict.path)) : [];
    state.serverConflicts = [...unresolved, ...response.conflicts.filter((conflict) =>
      !unresolved.some((file) => file.path === conflict.path))];
    if (response.status === "ok") {
      state.writing.stage = "accepted";
      await this.saveSettings();
      for (const file of captured) {
        state.baseline = state.baseline.filter((entry) => entry.path !== file.path);
        if (file.entry) state.baseline.push(file.entry);
      }
    } else {
      // Marker bytes are a conflict view, not contents at serverHead. Never fetch them as a blob or acknowledge them.
      for (const file of response.files) {
        const sent = captured.find((entry) => entry.path === file.path);
        if (!sent || file.op !== "upsert" || typeof file.contentBase64 !== "string" ||
            !response.conflicts.some((entry) => entry.path === file.path)) continue;
        const vault = new VaultState(this.vault);
        const folder = this.recoveryFolder();
        await vault.verifiedBackup(folder, (await vault.checkedEntryFor(file.path)) ? [file.path] : []);
        state.applying = { path: file.path, baseline: sent.entry, remote: file, remoteHead: response.serverHead,
          reason: "Interrupted server conflict display", uploadBlocked: true, backupFolder: folder };
        await this.saveSettings();
        const bytes = await vault.serverBytes(file, async () => { throw new Error("Conflict markers must be inline"); });
        if (!await vault.applyGuarded(file, sent.entry, bytes, () => this.assertShareContext(selected))) {
          state.reconciliation.push({ ...state.applying, reason: "Local edit during conflict response; bytes retained" });
        }
        delete state.applying;
        await this.saveSettings();
      }
    }
    delete state.writing;
    await this.saveSettings();
  }

  private async uploadShareBuffer(selected: ActiveShare, path: string, bytes: ArrayBuffer, entry: ManifestEntry): Promise<string> {
    const init = await this.shareWrite<UploadInitResponse>(selected, "/uploads", { path, sha256: entry.sha256, size: bytes.byteLength });
    const chunkSize = Math.max(1, Math.min(init.chunkSize || 512 * 1024, 2 * 1024 * 1024));
    for (let offset = 0; offset < bytes.byteLength;) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = await this.shareWrite<UploadChunkResponse>(selected, `/uploads/${encodeURIComponent(init.uploadId)}/chunk`,
        { offset, contentBase64: arrayBufferToBase64(bytes.slice(offset, end)) });
      if (chunk.received !== end) throw new Error(`Invalid upload progress: ${path}`);
      offset = end;
    }
    const complete = await this.shareWrite<UploadCompleteResponse>(selected, `/uploads/${encodeURIComponent(init.uploadId)}/complete`, {});
    if (complete.sha256 !== entry.sha256 || complete.size !== bytes.byteLength) throw new Error(`Upload verification failed: ${path}`);
    return complete.uploadId;
  }

  private async downloadShareFile(selected: PendingShareSelection | ActiveShare, file: ServerUpsert,
    head: string | null): Promise<ArrayBuffer> {
    if (!head) throw new Error("Missing remote version for reference download");
    return this.requestBinary("GET", `${this.sharePath(selected)}/blob?path=${encodeURIComponent(file.path)}&hash=${encodeURIComponent(head)}`);
  }

  private async performShareDownload(): Promise<void> {
    const selected = this.settings.activeShare!;
    await this.negotiateShare(selected);
    await new ShareReconciler(new VaultState(this.vault), selected.download, this.saveSettings,
      () => this.assertShareContext(selected)).preserveLocalChanges();
    await this.downloadSnapshot(selected);
    this.settings.lastSyncCompletedAt = new Date().toISOString();
    selected.download.lastDownloadedAt = this.settings.lastSyncCompletedAt;
    await this.saveSettings();
    new Notice(`Share downloads complete (${selected.capability}); ${selected.download.reconciliation.length} local reconciliation barrier(s). V2 uploads remain disabled.`);
  }

  async keepLocalReconciliation(path: string): Promise<void> {
    if (this.running) throw new Error("Wait for synchronization to finish");
    const selected = this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("No selected share");
    this.assertShareContext(selected);
    const record = this.localReconciliations().find((entry) => entry.path === path);
    if (!record) throw new Error("No local reconciliation record");
    record.localChoice = "keep-local";
    record.reason = "Local bytes retained by explicit choice; future upload still requires write reconciliation";
    await this.saveSettings();
  }

  /** An explicit, backed-up choice of current bytes against a freshly observed remote version. */
  async uploadLocalReconciliation(path: string): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.settings.activeShare;
      if (!selected || selected.status !== "writable") throw new Error("Enable writable share synchronization first");
      await this.requireShareWrite(selected);
      await this.recoverShareWrite(selected);
      await this.downloadSnapshot(selected);
      const record = selected.download.reconciliation.find((entry) => entry.path === path);
      if (!record) throw new Error("No local reconciliation record");
      if (selected.download.serverConflicts?.some((entry) => entry.path === path)) throw new Error("Use server conflict resolution for this path");
      const vault = new VaultState(this.vault);
      const file = await vault.capture(path);
      const folder = this.recoveryFolder();
      const copied = await vault.verifiedBackup(folder, file.entry ? [path] : []);
      if (!sameFile(copied[0] ?? null, file.entry)) throw new Error("File changed during reconciliation backup");
      record.backupFolder = folder;
      await this.saveSettings();
      await this.submitShareChanges(selected, [{ path, ...file }], record.remoteHead);
      if (!selected.download.serverConflicts?.some((entry) => entry.path === path)) {
        selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== path);
        await this.saveSettings();
      }
      await this.downloadSnapshot(selected);
    });
  }

  /** Initial upload is an explicit replacement decision, with local backup and a real remote base. */
  async initializeShareUpload(): Promise<void> {
    await this.exclusive(async () => {
      const pending = this.settings.pendingShareSelection;
      if (!pending || pending.download) throw new Error("Select an uninitialized share; resume existing recovery instead");
      await this.requireShareWrite(pending);
      const vault = new VaultState(this.vault);
      pending.download = { observedHead: null, baseline: [], reconciliation: [],
        initial: { backupFolder: this.recoveryFolder(), appliedPaths: [], complete: false } };
      await this.saveSettings();
      const backup = await vault.verifiedBackup(pending.download.initial.backupFolder, vault.paths().filter(sharePathSupported));
      pending.download.initial.backupManifest = backup;
      await this.saveSettings();
      const snapshot = await this.shareSnapshot(pending);
      const captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }> = [];
      const paths = new Set([...backup.map((entry) => entry.path), ...snapshot.files.map((file) => file.path)]);
      for (const path of paths) {
        if (!sharePathSupported(path)) continue;
        const file = await vault.capture(path);
        if (!sameFile(file.entry, backup.find((entry) => entry.path === path) ?? null)) {
          throw new Error(`Local file changed after initial backup: ${path}. Resume safe download reconciliation.`);
        }
        const remote = snapshot.files.find((entry) => entry.path === path);
        if (file.entry?.sha256 !== (remote?.op === "upsert" ? remote.sha256 : undefined)) captured.push({ path, entry: file.entry });
      }
      pending.download.baseline = snapshot.files.filter((file): file is ServerUpsert => file.op === "upsert" && sharePathSupported(file.path))
        .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size ?? 0, mtime: 0 }));
      pending.download.observedHead = snapshot.serverHead;
      pending.download.initial.complete = true;
      const { syncState: _old, status: _status, observedHead: _head, ...destination } = pending;
      const selected: ActiveShare = { ...destination, status: "writable", download: pending.download };
      this.settings.activeShare = selected;
      this.settings.pendingShareSelection = null;
      await this.saveSettings();
      if (captured.length) await this.submitShareChanges(selected, captured, snapshot.serverHead);
      await this.downloadSnapshot(selected);
      if (selected.download.serverConflicts?.length) {
        this.showConflictNotice(selected.download.serverConflicts);
        throw new Error("Initial upload encountered concurrent remote changes; resolve retained server conflicts before continuing");
      }
      selected.download.lastDownloadedAt = new Date().toISOString();
      this.settings.lastSyncCompletedAt = selected.download.lastDownloadedAt;
      await this.saveSettings();
    });
  }

  async useRemoteReconciliation(path: string): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.settings.activeShare;
      if (!selected) throw new Error("Resume initial download before reconciling individual files");
      await this.negotiateShare(selected);
      await this.downloadSnapshot(selected); // Refresh the target; never resolve a stale tombstone.
      const record = selected.download.reconciliation.find((entry) => entry.path === path);
      if (!record) return;
      const vaultState = new VaultState(this.vault);
      const backupFolder = this.recoveryFolder();
      const copied = await vaultState.verifiedBackup(backupFolder,
        (await vaultState.checkedEntryFor(path)) ? [path] : []);
      const expected = copied[0] ?? null;
      record.backupFolder = backupFolder;
      await this.saveSettings();
      const bytes = record.remote.op === "upsert" ? await vaultState.serverBytes(record.remote,
        (file) => this.downloadShareFile(selected, file, record.remoteHead)) : undefined;
      this.assertShareContext(selected);
      selected.download.applying = record;
      await this.saveSettings();
      if (!await vaultState.applyGuarded(record.remote, expected, bytes, () => this.assertShareContext(selected))) {
        record.reason = "Local file changed during reconciliation; bytes retained";
      } else {
        selected.download.baseline = selected.download.baseline.filter((entry) => entry.path !== path);
        if (record.remote.op === "upsert") selected.download.baseline.push({ path, sha256: record.remote.sha256,
          size: bytes!.byteLength, mtime: Date.now() });
        // The explicit remote choice discards the backed-up edit. It does not approve a local upload.
        selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== path);
      }
      delete selected.download.applying;
      await this.saveSettings();
      new Notice(`Local reconciliation processed for ${path}. Backup: ${backupFolder}`);
    });
  }

  updateSettings(settings: IosGitSyncSettings): void {
    if (settings.serverUrl !== this.settings.serverUrl) {
      this.oidcDiscoveryCache = null;
      this.oidcLoginConfig = null;
      this.oidcLoginServerUrl = null;
    }
    this.settings = settings;
    this.emitLoginStatus();
  }

  currentDeviceName(): string {
    return this.deviceName();
  }

  isSyncRunning(): boolean {
    return this.running;
  }

  async localChangeSummary(): Promise<{ changed: number; upserts: number; deletes: number }> {
    const manifest = await new VaultState(this.vault).computeManifest();
    const diff = diffManifests(manifest, this.synchronizedManifest());
    return {
      changed: diff.upsertPaths.length + diff.deletePaths.length,
      upserts: diff.upsertPaths.length,
      deletes: diff.deletePaths.length
    };
  }

  onSyncStateChange(listener: SyncStateListener): () => void {
    this.syncStateListeners.add(listener);
    listener(this.running);
    return () => {
      this.syncStateListeners.delete(listener);
    };
  }

  onLoginStatusChange(listener: LoginStatusListener): () => void {
    this.loginStatusListeners.add(listener);
    listener(this.loginStatus());
    return () => {
      this.loginStatusListeners.delete(listener);
    };
  }

  loginStatus(): LoginStatus {
    if (this.settings.lastLoginError) {
      return {
        state: "failed",
        title: "Login failed",
        detail: this.settings.lastLoginError
      };
    }

    if (!this.settings.oidcAccessToken) {
      return {
        state: "not-logged-in",
        title: "Not logged in",
        detail: "Log in to ObsidiSync before syncing or loading server history."
      };
    }

    return {
      state: "logged-in",
      title: "Logged in",
      detail: this.settings.userSlug ? `Signed in as ${this.settings.userSlug}.` : "Access token is configured."
    };
  }

  async recordLoginFailure(message: string): Promise<void> {
    this.settings.lastLoginError = message;
    this.settings.lastLoginAttemptAt = new Date().toISOString();
    await this.saveSettings();
    this.emitLoginStatus();
  }

  async authConfig(): Promise<ServerAuthConfig> {
    if (!this.settings.serverUrl) throw new Error("Set a sync server URL before logging in");
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    await this.checkServerCompatibility();
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${serverUrl}/v1/auth/config`,
      method: "GET",
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `Auth configuration failed: HTTP ${response.status}`);
    }
    return response.json as ServerAuthConfig;
  }

  async loginPassword(username: string, password: string, setup: boolean, setupToken?: string): Promise<void> {
    if (!this.settings.serverUrl) throw new Error("Set a sync server URL before logging in");
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    const requestBody: { username: string; password: string; setupToken?: string } = { username, password };
    if (setup && setupToken) requestBody.setupToken = setupToken;
    const response = await requestUrl({
      url: `${serverUrl}/v1/auth/password/${setup ? "setup" : "login"}`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(requestBody),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `Password login failed: HTTP ${response.status}`);
    }

    const body = response.json as PasswordLoginResponse;
    await this.storeServerSessionResponse(body, serverUrl);
  }

  async loadAuthenticatedUser(): Promise<void> {
    if (!this.settings.oidcAccessToken) throw new Error("Log in before loading the authenticated user");
    await this.checkServerCompatibility();
    const session = await this.getJson<AuthSessionResponse>("/v1/auth/session");
    this.rememberAuthenticatedUser(session);
    this.settings.lastLoginError = null;
    await this.saveSettings();
    this.emitLoginStatus();
  }

  async renewLoginIfNeeded(): Promise<boolean> {
    if (!this.settings.oidcRefreshToken) return false;

    const expiresAt = this.settings.oidcAccessTokenExpiresAt ? Date.parse(this.settings.oidcAccessTokenExpiresAt) : NaN;
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now() + OIDC_MAINTENANCE_REFRESH_WINDOW_MS) {
      return this.refreshOidcAccessToken();
    }

    const lastRefreshAt = this.settings.lastLoginAttemptAt ? Date.parse(this.settings.lastLoginAttemptAt) : NaN;
    if (Number.isNaN(lastRefreshAt) || lastRefreshAt <= Date.now() - OIDC_MAINTENANCE_REFRESH_INTERVAL_MS) {
      return this.refreshOidcAccessToken();
    }

    return false;
  }

  async sync(): Promise<SyncConflict[]> {
    if (this.running) {
      this.syncQueued = true;
      this.settings.syncStatus = "queued";
      this.settings.lastSyncError = null;
      await this.saveSettings();
      this.emitSyncState();
      new Notice("Git sync queued");
      return [];
    }

    const collectedConflicts: SyncConflict[] = [];
    do {
      this.syncQueued = false;
      const conflicts = await this.exclusive(() => this.performSync());
      if (conflicts && conflicts.length > 0) {
        collectedConflicts.push(...conflicts);
        break;
      }
    } while (this.syncQueued);

    return collectedConflicts;
  }

  private async performSync(): Promise<SyncConflict[]> {
    if (this.settings.activeShare) return this.performShareSync();
    const blockReason = this.syncBlocker?.();
    if (blockReason) {
      new Notice(blockReason);
      return [];
    }

    this.requireConfigured();
    await this.checkServerCompatibility();
    await this.register();

    const vaultState = new VaultState(this.vault);
    const { manifest, changes } = await vaultState.collectChanges(this.settings.localManifest, {
      stageUpload: (path, buffer, entry) => this.uploadBuffer(path, buffer, entry)
    });
    const request: SyncRequest = {
      baseHead: this.settings.serverHead || null,
      clientId: this.settings.clientId,
      deviceName: this.deviceName(),
      changes,
      clientManifest: manifest,
      fileContent: this.fileContentMode()
    };

    const response = await this.postJson<SyncResponse>(`${this.vaultPath()}/sync`, request);
    // On a conflict the server sends conflict-marker files. They must stay visible as local
    // changes so the next sync re-uploads them and the server keeps reporting the conflict;
    // recording them in the manifest would make the client believe they were synced.
    await this.applyServerFiles(vaultState, response.files, response.serverHead, hashesByPath(manifest), {
      persistManifest: response.status !== "conflict"
    });

    if (response.status === "conflict") {
      this.settings.syncStatus = "error";
      this.settings.lastSyncError = `Conflict in ${response.conflicts.length} file(s)`;
      await this.saveSettings();
      this.showConflictNotice(response.conflicts);
      return response.conflicts;
    }

    const completedAt = new Date().toISOString();
    this.settings.serverHead = response.serverHead;
    this.settings.lastSyncedAt = completedAt;
    this.settings.lastSyncCompletedAt = completedAt;
    this.settings.lastSyncError = null;
    this.settings.lastSyncChangeCount = changes.length;
    this.settings.localManifest = await vaultState.computeManifest();
    this.settings.initialSyncDone = true;
    await this.saveSettings();

    new Notice(changes.length > 0 ? `Git sync complete: ${changes.length} local change(s)` : "Git sync complete");
    return [];
  }

  async forcePushLocal(): Promise<void> {
    await this.exclusive(async () => {
      this.requireConfigured();
      await this.checkServerCompatibility();
      await this.register();

      const vaultState = new VaultState(this.vault);
      const probe = await this.probeServerState();
      const serverShaByPath = new Map<string, string>();
      for (const file of probe.files) {
        if (file.op === "upsert") serverShaByPath.set(file.path, file.sha256);
      }

      const localManifest = await vaultState.computeManifest();
      const localPaths = new Set(localManifest.map((entry) => entry.path));
      const changes: ClientChange[] = [];

      // Upload every local file the server does not already have byte-for-byte. Passing the
      // real server head as the base makes the server take the client content verbatim instead
      // of attempting a merge, so the push overwrites whatever was there.
      for (const entry of localManifest) {
        if (serverShaByPath.get(entry.path) === entry.sha256) continue;
        const buffer = await this.vault.adapter.readBinary(entry.path);
        const uploadId = await this.uploadBuffer(entry.path, buffer, entry);
        changes.push({ path: entry.path, op: "upsert", uploadId, sha256: entry.sha256, mtime: entry.mtime });
      }
      for (const file of probe.files) {
        if (file.op === "upsert" && !localPaths.has(file.path)) {
          changes.push({ path: file.path, op: "delete" });
        }
      }

      const request: SyncRequest = {
        baseHead: probe.serverHead,
        clientId: this.settings.clientId,
        deviceName: this.deviceName(),
        changes,
        clientManifest: localManifest,
        fileContent: this.fileContentMode()
      };
      const response = await this.postJson<SyncResponse>(`${this.vaultPath()}/sync`, request);
      if (response.status === "conflict") {
        throw new Error("Force push could not complete because the server changed during setup. Try again.");
      }

      const completedAt = new Date().toISOString();
      this.settings.serverHead = response.serverHead;
      this.settings.lastSyncedAt = completedAt;
      this.settings.lastSyncCompletedAt = completedAt;
      this.settings.lastSyncError = null;
      this.settings.lastSyncChangeCount = changes.length;
      this.settings.localManifest = await vaultState.computeManifest();
      this.settings.initialSyncDone = true;
      await this.saveSettings();

      new Notice(`Local vault pushed to server: ${changes.length} change(s)`);
    });
  }

  async overwriteLocalFromServer(backupFolder: string): Promise<void> {
    await this.exclusive(async () => {
      this.requireConfigured();
      await this.checkServerCompatibility();
      await this.register();

      const vaultState = new VaultState(this.vault);
      const backupTarget = backupFolder.trim();
      const backedUp = backupTarget ? await vaultState.backupTo(backupTarget) : 0;

      const probe = await this.probeServerState();
      const serverPaths = new Set<string>();
      for (const file of probe.files) {
        if (file.op === "upsert") serverPaths.add(file.path);
      }

      const localManifest = await vaultState.computeManifest();
      const deletePaths = localManifest.map((entry) => entry.path).filter((path) => !serverPaths.has(path));
      await vaultState.deletePaths(deletePaths);
      await this.applyServerFiles(vaultState, probe.files, probe.serverHead, hashesByPath(localManifest));

      const completedAt = new Date().toISOString();
      this.settings.serverHead = probe.serverHead;
      this.settings.lastSyncedAt = completedAt;
      this.settings.lastSyncCompletedAt = completedAt;
      this.settings.lastSyncError = null;
      this.settings.lastSyncChangeCount = probe.files.length;
      this.settings.localManifest = await vaultState.computeManifest();
      this.settings.initialSyncDone = true;
      await this.saveSettings();

      const backupNote = backedUp > 0 ? ` (${backedUp} file(s) backed up to ${backupTarget})` : "";
      new Notice(`Local vault overwritten from server: ${probe.files.length} file(s)${backupNote}`);
    });
  }

  // Reads the server's current head and full file list without mutating the server: an empty
  // change set means nothing is committed or pushed, and an empty client manifest makes the
  // server report every file it has. In reference mode this is metadata only; contents are
  // fetched per file when they are actually needed.
  private async probeServerState(): Promise<{ serverHead: string | null; files: ServerFileChange[] }> {
    const request: SyncRequest = {
      baseHead: this.settings.serverHead || null,
      clientId: this.settings.clientId,
      deviceName: this.deviceName(),
      changes: [],
      clientManifest: [],
      fileContent: this.fileContentMode()
    };
    const response = await this.postJson<SyncResponse>(`${this.vaultPath()}/sync`, request);
    return { serverHead: response.serverHead, files: response.files };
  }

  async history(path?: string): Promise<HistoryEntry[]> {
    const root = await this.readVaultPath();
    const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.getJson<HistoryEntry[]>(`${root}/history${suffix}`);
  }

  async devices(): Promise<DeviceEntry[]> {
    return this.getJson<DeviceEntry[]>(`${await this.readVaultPath()}/devices`);
  }

  async deviceVersions(path: string): Promise<DeviceVersionEntry[]> {
    const root = await this.readVaultPath();
    try {
      return await this.getJson<DeviceVersionEntry[]>(`${root}/files/device-versions?path=${encodeURIComponent(path)}`);
    } catch (error) {
      if (this.settings.activeShare) throw error;
      // Older servers don't have this endpoint yet; degrade to no badges.
      return [];
    }
  }

  async saveVersionMetadata(request: VersionMetadataRequest): Promise<void> {
    if (this.settings.activeShare) {
      if (!this.canWriteSelectedShare()) throw new Error("Share metadata is read-only");
      await this.shareWrite(this.settings.activeShare, "/files/version-metadata", request);
      return;
    }
    this.requireConfigured();
    await this.postJson<void>(`${this.vaultPath()}/files/version-metadata`, request);
  }

  async fileAtVersion(path: string, hash: string): Promise<VersionFileResponse> {
    const root = await this.readVaultPath();
    const file = await this.getJson<VersionFileResponse>(`${root}/file?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`);
    if (this.settings.activeShare && await sha256Hex(base64ToArrayBuffer(file.contentBase64)) !== file.sha256) {
      throw new Error(`History download checksum mismatch: ${path}`);
    }
    return file;
  }

  /**
   * Pushes one or more conflict resolutions in a single request and returns the conflicts the
   * server still reports afterwards (empty when everything was accepted).
   */
  async resolveConflicts(resolutions: ConflictResolution[]): Promise<SyncConflict[]> {
    if (resolutions.length === 0) return [];
    if (this.running) {
      throw new Error("A sync is running. Wait for it to finish, then try again.");
    }
    if (this.settings.activeShare) {
      const result = await this.exclusive(async () => {
        const selected = this.settings.activeShare!;
        if (!this.canWriteSelectedShare()) throw new Error("Server conflict resolution requires writable share access");
        await this.requireShareWrite(selected);
        if (selected.download.applying) await this.downloadSnapshot(selected);
        await this.recoverShareWrite(selected);
        const pending = await this.pendingConflicts();
        const vault = new VaultState(this.vault);
        const captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }> = [];
        for (const resolution of resolutions) {
          if (!sharePathSupported(resolution.path) || !pending.some((entry) => entry.path === resolution.path)) {
            throw new Error("Only supported pending server conflicts may be resolved");
          }
          const original = await vault.capture(resolution.path);
          const folder = this.recoveryFolder();
          const copied = await vault.verifiedBackup(folder, original.entry ? [resolution.path] : []);
          if (!sameFile(copied[0] ?? null, original.entry)) throw new Error("File changed during resolution backup");
          if (resolution.kind !== "current") {
            const bytes = resolution.kind === "text" ? new TextEncoder().encode(resolution.content).buffer
              : resolution.kind === "binary" ? base64ToArrayBuffer(resolution.contentBase64) : undefined;
            const target: ServerFileChange = bytes ? { path: resolution.path, op: "upsert", sha256: await sha256Hex(bytes) }
              : { path: resolution.path, op: "delete" };
            selected.download.applying = { path: resolution.path, baseline: original.entry, remote: target,
              remoteHead: selected.download.observedHead, reason: "Interrupted explicit conflict choice", uploadBlocked: true, backupFolder: folder };
            await this.saveSettings();
            if (!await vault.applyGuarded(target, original.entry, bytes, () => this.assertShareContext(selected))) {
              throw new Error("Local edit during resolution; bytes retained");
            }
            delete selected.download.applying;
            await this.saveSettings();
          }
          captured.push({ path: resolution.path, entry: (await vault.capture(resolution.path)).entry });
        }
        await this.submitShareChanges(selected, captured, selected.download.observedHead, true);
        const remaining = await this.readShareConflicts(selected, captured.map((file) => file.path));
        for (const file of captured) if (!remaining.some((entry) => entry.path === file.path)) {
          selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== file.path);
        }
        await this.saveSettings();
        await this.downloadSnapshot(selected);
        return remaining;
      });
      return result ?? [];
    }
    const result = await this.exclusive(async () => {
      this.requireConfigured();
      await this.checkServerCompatibility();
      const files: ResolveRequest["files"] = [];
      for (const resolution of resolutions) {
        if (resolution.kind === "delete") {
          if (await this.vault.adapter.exists(resolution.path, true)) {
            await this.vault.adapter.remove(resolution.path);
          }
          files.push({ path: resolution.path, delete: true });
          continue;
        }
        if (resolution.kind === "text") {
          await this.vault.adapter.write(resolution.path, resolution.content);
        }
        if (resolution.kind === "binary") throw new Error("Binary choices require selected-share guarded resolution");
        const buffer = await this.vault.adapter.readBinary(resolution.path);
        const uploadId = await this.uploadBuffer(resolution.path, buffer);
        files.push({ path: resolution.path, uploadId });
      }
      const request: ResolveRequest = {
        clientId: this.settings.clientId,
        deviceName: this.deviceName(),
        files,
        fileContent: this.fileContentMode()
      };
      const response = await this.postJson<SyncResponse>(`${this.vaultPath()}/resolve`, request);
      const vaultState = new VaultState(this.vault);
      await this.applyServerFiles(vaultState, response.files, response.serverHead, hashesByPath(this.settings.localManifest));
      // Only the files that were just pushed count as synced. Recomputing the whole manifest
      // here would mark every other unsynced local edit as already on the server.
      let manifest = this.settings.localManifest;
      for (const resolution of resolutions) {
        const entry = resolution.kind === "delete" ? null : await vaultState.manifestEntryFor(resolution.path);
        manifest = entry ? upsertManifestEntry(manifest, entry) : removeManifestEntry(manifest, resolution.path);
      }
      this.settings.localManifest = manifest;
      this.settings.serverHead = response.serverHead;
      this.settings.lastSyncedAt = new Date().toISOString();
      this.settings.lastSyncCompletedAt = this.settings.lastSyncedAt;
      this.settings.lastSyncError = response.status === "conflict" ? "Conflict remains after resolve attempt" : null;
      await this.saveSettings();
      return response.status === "conflict" ? response.conflicts : [];
    });
    return result ?? [];
  }

  /**
   * Conflicts the server still expects this device to resolve. Older servers have no such
   * endpoint; they answer 404 and this returns an empty list.
   */
  async pendingConflicts(): Promise<SyncConflict[]> {
    if (this.settings.activeShare) {
      await this.readVaultPath();
      return this.readShareConflicts(this.settings.activeShare);
    }
    this.requireConfigured();
    try {
      const conflicts = await this.getJson<SyncConflict[]>(
        `${this.vaultPath()}/conflicts?clientId=${encodeURIComponent(this.settings.clientId)}`
      );
      return Array.isArray(conflicts) ? conflicts : [];
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) return [];
      throw error;
    }
  }

  async resolveFile(path: string): Promise<SyncConflict[]> {
    return this.resolveConflicts([{ path, kind: "current" }]);
  }

  async resolveTextFile(path: string, content: string): Promise<SyncConflict[]> {
    return this.resolveConflicts([{ path, kind: "text", content }]);
  }

  /**
   * Re-checks the server and returns why device passwords are unavailable, or `null` if they work.
   * Servers without feature flags never advertise the feature, so old servers are reported as such.
   */
  async devicePasswordsUnavailableReason(): Promise<string | null> {
    this.legacyCredentialContext();
    await this.checkServerCompatibility();
    return devicePasswordsAvailabilityMessage(this.settings);
  }

  async listDevicePasswords(): Promise<DevicePasswordEntry[]> {
    return (await this.legacyCredentialInventory()).entries;
  }

  legacyCredentialContext(): LegacyManagementContext {
    captureLegacyContext(this.settings);
    const context = this.settings.legacyManagementContext;
    if (!context || context.serverUrl !== serverIdentity(this.settings.serverUrl)) {
      throw new Error("Original legacy namespace is unavailable on this server. Retained context has not been changed.");
    }
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    if (!this.settings.oidcAccessToken || /\s/.test(this.settings.oidcAccessToken)) {
      throw new Error("Log in before managing legacy credentials");
    }
    assertNamespaceSlug(context.userSlug, "Legacy user");
    assertNamespaceSlug(context.vaultSlug, "Legacy vault");
    return { ...context };
  }

  /** Bind modal intent to the account and both independent destinations, not their mutable capabilities. */
  credentialContextKey(): string {
    return JSON.stringify([serverIdentity(this.settings.serverUrl), this.settings.userSlug,
      this.settings.authenticatedIdentity, this.settings.legacyManagementContext,
      (this.settings.activeShare ?? this.settings.pendingShareSelection)?.shareId]);
  }

  async legacyCredentialInventory(): Promise<{ entries: DevicePasswordEntry[]; managementAllowed: boolean }> {
    const context = this.legacyCredentialContext();
    const response = await this.devicePasswordRequest(() =>
      this.requestWithAuth("GET", this.legacyCredentialPath(context), undefined, context));
    const header = Object.entries(response.headers ?? {}).find(([key]) =>
      key.toLowerCase() === "x-obsidisync-legacy-grant-management")?.[1];
    return { entries: response.json as DevicePasswordEntry[], managementAllowed: header === "allowed" };
  }

  private legacyCredentialPath(context: LegacyManagementContext): string {
    return `/v1/users/${encodeURIComponent(context.userSlug)}/vaults/${encodeURIComponent(context.vaultSlug)}/device-passwords`;
  }

  async createDevicePassword(label: string, folder: string): Promise<CreatedDevicePassword> {
    const context = this.legacyCredentialContext();
    const request: CreateDevicePasswordRequest = { label, folder };
    const response = await this.devicePasswordRequest(() =>
      this.requestWithAuth("POST", this.legacyCredentialPath(context), request, context));
    return response.json as CreatedDevicePassword;
  }

  async revokeDevicePassword(id: string): Promise<void> {
    const context = this.legacyCredentialContext();
    await this.devicePasswordRequest(() => this.requestWithAuth("DELETE",
      `${this.legacyCredentialPath(context)}/${encodeURIComponent(id)}`, undefined, context));
  }

  async shareCredentialInventory(): Promise<{ shareId: string; capability: "read" | "read-write";
      entries: ShareCredentialEntry[] }> {
    const selected = this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("Choose a share to manage share-native grants.");
    await this.negotiateShare(selected);
    const entries = await this.getJson<ShareCredentialEntry[]>(`${this.sharePath(selected)}/device-passwords`);
    return { shareId: selected.shareId, capability: selected.capability, entries };
  }

  async createShareCredential(label: string, folder: string, capability: "read" | "read-write"):
      Promise<CreatedShareCredential> {
    const selected = this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("Choose a share first.");
    await this.negotiateShare(selected);
    if (capability !== "read" && capability !== "read-write") throw new Error("Invalid credential capability");
    if (capability === "read-write" && selected.capability !== "read-write") throw new Error("Share is read-only");
    return this.postJson<CreatedShareCredential>(`${this.sharePath(selected)}/device-passwords`, { label, folder, capability });
  }

  async revokeShareCredential(id: string): Promise<void> {
    const selected = this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("Choose a share first.");
    await this.negotiateShare(selected);
    if (selected.capability !== "read-write") throw new Error("Read-only membership requires host-operator revocation.");
    await this.deleteJson(`${this.sharePath(selected)}/device-passwords/${encodeURIComponent(id)}`);
  }

  /** An old server has no device-password routes at all and answers 404; say so instead of "not found". */
  private async devicePasswordRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404 && !this.settings.serverFeatures.includes("webdavDevicePasswords")) {
        throw new Error(
          devicePasswordsAvailabilityMessage({ ...this.settings, lastServerCheckAt: this.settings.lastServerCheckAt ?? new Date().toISOString() }) ??
            "The sync server does not support device passwords yet. Update the server."
        );
      }
      throw error;
    }
  }

  async beginOidcDeviceLogin(): Promise<OidcDeviceAuthorization> {
    const config = await this.serverOidcLoginConfig();

    const discovery = await this.oidcDiscovery();
    const params = new URLSearchParams();
    params.set("client_id", config.clientId);
    params.set("scope", config.scope || "openid profile email");
    if (config.audience) {
      params.set("audience", config.audience);
      params.set("resource", config.audience);
    }

    const response = await requestUrl({
      url: discovery.device_authorization_endpoint,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: params.toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `OIDC device authorization failed: HTTP ${response.status}`);
    }
    return response.json as OidcDeviceAuthorization;
  }

  async pollOidcDeviceLogin(deviceCode: string, intervalSeconds: number, expiresInSeconds: number): Promise<void> {
    const discovery = await this.oidcDiscovery();
    const startedAt = Date.now();
    let interval = Math.max(intervalSeconds || 5, 1);

    while (Date.now() - startedAt < expiresInSeconds * 1000) {
      await sleep(interval * 1000);

      const params = new URLSearchParams();
      const config = await this.serverOidcLoginConfig();
      params.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      params.set("device_code", deviceCode);
      params.set("client_id", config.clientId);
      if (config.audience) {
        params.set("audience", config.audience);
        params.set("resource", config.audience);
      }

      const response = await requestUrl({
        url: discovery.token_endpoint,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: params.toString(),
        throw: false
      });
      const body = response.json as OidcTokenResponse;

      if (response.status >= 200 && response.status < 300 && body.access_token) {
        await this.exchangeOidcAccessToken(body.access_token);
        await this.loadAuthenticatedUser();
        this.settings.lastLoginError = null;
        this.settings.lastLoginAttemptAt = new Date().toISOString();
        await this.saveSettings();
        this.emitLoginStatus();
        new Notice("OIDC login complete");
        return;
      }

      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (body.error === "expired_token") {
        throw new Error("OIDC device login expired");
      }

      throw new Error(body.error_description || body.error || response.text || `OIDC token polling failed: HTTP ${response.status}`);
    }

    throw new Error("OIDC device login expired");
  }

  private async register(): Promise<void> {
    const request: RegisterRequest = {
      remoteUrl: this.settings.remoteUrl.trim(),
      branch: MAIN_BRANCH,
      authorName: this.settings.authorName,
      authorEmail: this.settings.authorEmail
    };
    await this.postJson<RegisterResponse>(`${this.vaultPath()}/register`, request);
    this.settings.branch = MAIN_BRANCH;
    await this.saveSettings();
  }

  async checkServerCompatibility(): Promise<ServerInfoResponse> {
    if (!this.settings.serverUrl) throw new Error("Set a sync server URL before contacting the server");
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${serverUrl}/v1/server/info`,
      method: "GET",
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `Server compatibility check failed: HTTP ${response.status}`);
    }

    const info = response.json as ServerInfoResponse;
    if (!Number.isFinite(info.apiVersion) || !Number.isFinite(info.minClientApiVersion)) {
      throw new Error("Sync server did not report a valid API version");
    }
    if (info.minClientApiVersion > CLIENT_API_VERSION || info.apiVersion < CLIENT_API_VERSION) {
      throw new Error(`Sync server API ${info.apiVersion} is not compatible with client API ${CLIENT_API_VERSION}`);
    }

    this.settings.serverVersion = info.version;
    this.settings.serverApiVersion = info.apiVersion;
    this.settings.serverFeatures = Array.isArray(info.features) ? info.features.filter((feature) => typeof feature === "string") : [];
    this.settings.lastServerCheckAt = new Date().toISOString();
    await this.saveSettings();
    return info;
  }

  private async storeServerSessionResponse(body: ServerSessionResponse | PasswordLoginResponse, serverUrl: string): Promise<void> {
    if (serverIdentity(this.settings.serverUrl) !== serverIdentity(serverUrl)) {
      throw new Error("Server changed during login/refresh. Log in again.");
    }
    if (!body.accessToken) throw new Error("Server session response did not include an access token");
    if (!body.refreshToken) throw new Error("Server session response did not include a refresh token");
    this.settings.oidcAccessToken = body.accessToken;
    this.settings.oidcRefreshToken = body.refreshToken;
    this.settings.lastLoginError = null;
    this.settings.lastLoginAttemptAt = new Date().toISOString();
    this.settings.oidcAccessTokenExpiresAt =
      typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn) && body.expiresIn > 0
        ? new Date(Date.now() + body.expiresIn * 1000).toISOString()
        : null;
    this.rememberAuthenticatedUser(body);
    await this.saveSettings();
    this.emitLoginStatus();
  }

  private async exchangeOidcAccessToken(oidcAccessToken: string): Promise<void> {
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${serverUrl}/v1/auth/oidc/login`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ accessToken: oidcAccessToken }),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `OIDC server session exchange failed: HTTP ${response.status}`);
    }
    await this.storeServerSessionResponse(response.json as ServerSessionResponse, serverUrl);
  }

  private async refreshOidcAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshToken = this.settings.oidcRefreshToken;
    if (!refreshToken) return false;

    this.refreshInFlight = this.refreshOidcAccessTokenOnce(refreshToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshOidcAccessTokenOnce(refreshToken: string): Promise<boolean> {
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${serverUrl}/v1/auth/session/refresh`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ refreshToken }),
      throw: false
    });
    const body = (response.json ?? {}) as Partial<ServerSessionResponse> & OidcTokenResponse;
    if (response.status >= 200 && response.status < 300 && body.accessToken) {
      await this.storeServerSessionResponse(body as ServerSessionResponse, serverUrl);
      return true;
    }

    if (response.status === 401 || response.status === 403 || body.error === "invalid_grant") {
      if (this.settings.oidcRefreshToken !== refreshToken) return true;
      this.settings.oidcRefreshToken = "";
      this.settings.oidcAccessTokenExpiresAt = null;
      this.settings.lastLoginError = "Re-login failed: refresh token was rejected. Log in to ObsidiSync again.";
      this.settings.lastLoginAttemptAt = new Date().toISOString();
      await this.saveSettings();
      this.emitLoginStatus();
      return false;
    }

    const message = body.error_description || body.error || response.text || `OIDC token refresh failed: HTTP ${response.status}`;
    await this.recordLoginFailure(`Re-login failed: ${message}`);
    throw new Error(message);
  }

  private async refreshExpiringOidcAccessToken(windowMs = OIDC_REFRESH_WINDOW_MS): Promise<void> {
    if (!this.settings.oidcRefreshToken || !this.settings.oidcAccessTokenExpiresAt) return;

    const expiresAt = Date.parse(this.settings.oidcAccessTokenExpiresAt);
    if (Number.isNaN(expiresAt) || expiresAt > Date.now() + windowMs) return;

    if (!(await this.refreshOidcAccessToken())) {
      if (!this.settings.lastLoginError) {
        await this.recordLoginFailure("Login expired or unauthorized. Log in to ObsidiSync again.");
      }
      throw new Error("Login expired or unauthorized. Log in to ObsidiSync again.");
    }
  }

  private fileContentMode(): FileContentMode {
    return serverSupportsFileReferences(this.settings.serverFeatures) ? "reference" : "inline";
  }

  /**
   * Applies server changes file by file. Files the server sent as references are downloaded
   * individually and verified; files already on disk with the same hash are skipped; progress is
   * persisted to the local manifest as it goes, so an interrupted sync continues where it stopped
   * instead of re-downloading (or worse, re-uploading) everything on the next run.
   */
  private async applyServerFiles(
    vaultState: VaultState,
    files: ServerFileChange[],
    serverHead: string | null,
    localHashes: Map<string, string>,
    options: { persistManifest?: boolean } = {}
  ): Promise<void> {
    const persistManifest = options.persistManifest ?? true;
    const notice = files.length >= DOWNLOAD_PROGRESS_NOTICE_MIN_FILES ? new Notice("ObsidiSync: applying server changes...", 0) : null;
    let appliedSinceSave = 0;
    try {
      await vaultState.applyServerFiles(files, {
        localHashes,
        download: (file) => this.downloadServerFile(file, serverHead),
        onProgress: (done, total, path) => notice?.setMessage(describeDownloadProgress(done, total, path)),
        onApplied: !persistManifest ? undefined : async ({ path, entry }) => {
          this.settings.localManifest = entry
            ? upsertManifestEntry(this.settings.localManifest, entry)
            : removeManifestEntry(this.settings.localManifest, path);
          appliedSinceSave += 1;
          if (appliedSinceSave >= DOWNLOAD_PROGRESS_SAVE_EVERY) {
            appliedSinceSave = 0;
            await this.saveSettings();
          }
        }
      });
    } finally {
      if (appliedSinceSave > 0) await this.saveSettings();
      notice?.hide();
    }
  }

  private async downloadServerFile(file: ServerUpsert, serverHead: string | null): Promise<ArrayBuffer> {
    if (!serverHead) throw new Error(`Server sent ${file.path} without content or a version to fetch it from`);
    const buffer = await this.requestBinary(
      "GET",
      `${this.vaultPath()}/blob?path=${encodeURIComponent(file.path)}&hash=${encodeURIComponent(serverHead)}`
    );
    const actual = await sha256Hex(buffer);
    if (actual !== file.sha256) {
      throw new Error(`Downloaded ${file.path} does not match the server checksum`);
    }
    return buffer;
  }

  private async uploadBuffer(path: string, buffer: ArrayBuffer, entry?: ManifestEntry): Promise<string> {
    const sha256 = entry?.sha256 ?? (await sha256Hex(buffer));
    const initRequest: UploadInitRequest = {
      path,
      sha256,
      size: buffer.byteLength
    };
    const init = await this.postJson<UploadInitResponse>(`${this.vaultPath()}/uploads`, initRequest);
    const chunkSize = Math.max(1, Math.min(init.chunkSize || 512 * 1024, 2 * 1024 * 1024));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const chunk = buffer.slice(offset, Math.min(offset + chunkSize, buffer.byteLength));
      const response = await this.postJson<UploadChunkResponse>(`${this.vaultPath()}/uploads/${encodeURIComponent(init.uploadId)}/chunk`, {
        offset,
        contentBase64: arrayBufferToBase64(chunk)
      });
      offset = response.received;
    }

    const complete = await this.postJson<UploadCompleteResponse>(`${this.vaultPath()}/uploads/${encodeURIComponent(init.uploadId)}/complete`, {});
    if (complete.sha256 !== sha256 || complete.size !== buffer.byteLength) {
      throw new Error(`Upload verification failed for ${path}`);
    }
    return complete.uploadId;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>("POST", path, body);
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>("GET", path);
  }

  private async deleteJson<T>(path: string): Promise<T> {
    return this.requestJson<T>("DELETE", path);
  }

  private async requestJson<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const response = await this.requestWithAuth(method, path, body);
    return response.json as T;
  }

  private async requestBinary(method: "GET", path: string): Promise<ArrayBuffer> {
    const response = await this.requestWithAuth(method, path);
    return response.arrayBuffer;
  }

  private async requestWithAuth(method: "GET" | "POST" | "DELETE", path: string, body?: unknown,
      legacyCredential?: LegacyManagementContext): Promise<RequestUrlResponse> {
    const selected = path.startsWith("/v2/shares/") ? this.settings.activeShare ?? this.settings.pendingShareSelection : null;
    const legacyAccount = legacyCredential ? JSON.stringify([this.settings.userSlug, this.settings.authenticatedIdentity]) : null;
    const assertDestination = () => {
      if (path.startsWith("/v1/users/")) {
        if (legacyCredential) {
          const current = this.legacyCredentialContext();
          const base = this.legacyCredentialPath(legacyCredential);
          const id = path.slice(base.length + 1);
          const validRoute = method === "DELETE" ? path.startsWith(`${base}/`) && id.length > 0 &&
            id !== "." && id !== ".." && !id.includes("/") : path === base;
          if (!validRoute || current.serverUrl !== legacyCredential.serverUrl ||
              current.userSlug !== legacyCredential.userSlug || current.vaultSlug !== legacyCredential.vaultSlug ||
              JSON.stringify([this.settings.userSlug, this.settings.authenticatedIdentity]) !== legacyAccount) {
            throw new Error("Legacy credential context changed during request");
          }
        } else {
          const blocked = this.destinationBlocker();
          if (blocked) throw new Error(blocked);
        }
      }
      if (selected) this.assertShareContext(selected);
    };
    assertDestination();
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    await this.refreshExpiringOidcAccessToken();
    assertDestination();
    const send = () => {
      assertDestination();
      if (serverIdentity(this.settings.serverUrl) !== serverIdentity(serverUrl)) {
        throw new Error("Server changed during request. Try again.");
      }
      return requestUrl({
        url: `${serverUrl}${path}`,
        method,
        ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
        headers: {
          Authorization: `Bearer ${this.settings.oidcAccessToken}`
        },
        throw: false
      });
    };

    let response = await send();
    if (response.status === 401) {
      if (await this.refreshOidcAccessToken()) {
        assertDestination();
        response = await send();
      }
      if (response.status === 401) {
        if (!this.settings.lastLoginError) {
          await this.recordLoginFailure("Login expired or unauthorized. Log in to ObsidiSync again.");
        }
        throw new Error("Login expired or unauthorized. Log in to ObsidiSync again.");
      }
    }

    if (response.status < 200 || response.status >= 300) {
      throw new HttpStatusError(response.status, serverErrorMessage(responseText(response), response.status));
    }
    assertDestination();
    return response;
  }

  private async oidcDiscovery(): Promise<OidcDiscovery> {
    if (this.oidcDiscoveryCache) return this.oidcDiscoveryCache;
    const issuer = (await this.serverOidcLoginConfig()).issuer.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${issuer}/.well-known/openid-configuration`,
      method: "GET",
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.text || `OIDC discovery failed: HTTP ${response.status}`);
    }
    const discovery = response.json as OidcDiscovery;
    if (!discovery.device_authorization_endpoint || !discovery.token_endpoint) {
      throw new Error("OIDC issuer does not advertise device authorization and token endpoints");
    }
    assertSecureHttpUrl(discovery.device_authorization_endpoint, "OIDC device authorization endpoint");
    assertSecureHttpUrl(discovery.token_endpoint, "OIDC token endpoint");
    this.oidcDiscoveryCache = discovery;
    return discovery;
  }

  private async serverOidcLoginConfig(): Promise<Extract<ServerAuthConfig, { type: "oidc" }>> {
    const serverUrl = this.settings.serverUrl.replace(/\/+$/, "");
    if (this.oidcLoginConfig && this.oidcLoginServerUrl === serverUrl) return this.oidcLoginConfig;
    const config = await this.authConfig();
    if (config.type !== "oidc") {
      throw new Error("This server is not configured for OIDC device login");
    }
    assertSecureHttpUrl(config.issuer, "OIDC issuer");
    this.oidcDiscoveryCache = null;
    this.oidcLoginConfig = config;
    this.oidcLoginServerUrl = serverUrl;
    return config;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.running) {
      new Notice("Git sync is already running");
      return undefined;
    }

    this.running = true;
    this.settings.syncStatus = "running";
    this.settings.lastSyncAttemptAt = new Date().toISOString();
    this.settings.lastSyncError = null;
    await this.saveSettings();
    this.emitSyncState();
    try {
      const result = await operation();
      this.settings.syncStatus = this.syncQueued ? "queued" : "idle";
      await this.saveSettings();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.syncStatus = "error";
      this.settings.lastSyncError = message;
      await this.saveSettings();
      new Notice(`Git sync failed: ${message}`, 10000);
      throw error;
    } finally {
      this.running = false;
      this.emitSyncState();
    }
  }

  private requireConfigured(): void {
    captureLegacyContext(this.settings);
    const blocked = this.destinationBlocker();
    if (blocked) throw new Error(blocked);
    if (!this.settings.serverUrl) throw new Error("Set a sync server URL before syncing");
    if (!this.settings.oidcAccessToken) throw new Error("Set an access token before syncing");
    if (!this.settings.userSlug) throw new Error("Set a user namespace before syncing");
    if (!this.settings.vaultSlug) throw new Error("Set a vault namespace before syncing");
    this.settings.branch = MAIN_BRANCH;
    assertSecureHttpUrl(this.settings.serverUrl, "Sync server URL");
    assertNamespaceSlug(this.settings.userSlug, "User namespace");
    assertNamespaceSlug(this.settings.vaultSlug, "Vault namespace");
    assertGitBranch(MAIN_BRANCH);
    if (/\s/.test(this.settings.oidcAccessToken)) throw new Error("Access token must not contain whitespace");
    if (this.settings.remoteUrl && (this.settings.remoteUrl.length > 2048 || /[\s\0]/.test(this.settings.remoteUrl))) {
      throw new Error("Git remote URL is invalid");
    }
  }

  private vaultPath(): string {
    return `/v1/users/${encodeURIComponent(this.settings.userSlug)}/vaults/${encodeURIComponent(this.settings.vaultSlug)}`;
  }

  private deviceName(): string {
    return getDeviceName(this.settings.deviceName);
  }

  private showConflictNotice(conflicts: SyncConflict[]): void {
    const notice = new Notice(`Git sync conflict in ${conflicts.length} file(s). Click to choose a resolution.`, 15000);
    if (!this.onConflictNotice) return;

    notice.messageEl.style.cursor = "pointer";
    notice.messageEl.title = "Open conflict resolver";
    notice.messageEl.tabIndex = 0;

    const openResolver = () => {
      notice.hide();
      this.onConflictNotice?.(conflicts);
    };
    notice.messageEl.onclick = openResolver;
    notice.messageEl.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openResolver();
      }
    };
  }

  private emitSyncState(): void {
    for (const listener of this.syncStateListeners) {
      listener(this.running);
    }
  }

  private emitLoginStatus(): void {
    const status = this.loginStatus();
    for (const listener of this.loginStatusListeners) {
      listener(status);
    }
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

function responseText(response: RequestUrlResponse): string | undefined {
  try {
    return response.text;
  } catch {
    // Binary bodies cannot be decoded as text.
    return undefined;
  }
}

function serverErrorMessage(text: string | undefined, status: number): string {
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return text;
  }
  return `HTTP ${status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function validShare(share: ShareEntry): boolean {
  return !!share && typeof share.shareId === "string" && /^s_[a-f0-9]{32}$/.test(share.shareId) &&
    typeof share.label === "string" && ["read", "read-write"].includes(share.capability);
}
