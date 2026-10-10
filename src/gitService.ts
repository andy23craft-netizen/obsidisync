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
import { assertGitBranch, assertNamespaceSlug, assertSecureHttpUrl, assertSafeVaultPath } from "./security";
import { ServerUpsert, sha256Hex, VaultState } from "./vaultState";
import { captureLegacyContext, serverIdentity, syncDestinationBlocker } from "./shareSelection";
import { ActiveShare, LocalReconciliation, ShareReconciler, sharePathSupported, sameFile } from "./shareReconciliation";
import type { PendingShareSelection, LegacyManagementContext } from "./shareSelection";
import { assertFreshCompositeVault, assertMountAction, assertMountPrefixes, captureMountAction,
  compositePathSupported, mountPathBlocked, pathKey, recordCompositeMove, resolveMount, validateComposite } from "./composite";
import type { CompositeMount, MountActionToken } from "./composite";
import { MountedVaultState } from "./mountedVaultState";
import { LocalLifecycle, cloneSettings, lifecycleBlocker } from "./localLifecycle";
import type { ConversionMapping } from "./localLifecycle";
import type { CompositeState } from "./composite";

export interface ConversionPreview {
  configuration: string;
  proposed: CompositeState;
  mappings: ConversionMapping[];
  exclusions: string[];
}

export interface HistoryOwnership { mountId: string; shareId: string; destination: string }
export interface FileContext {
  localPath: string;
  path: string;
  mountId?: string;
  ownership?: HistoryOwnership;
  label: string;
  guard: () => void;
}

type SaveSettings = () => Promise<void>;
interface ShareAction {
  token?: MountActionToken;
  guard: () => void;
  save: SaveSettings;
  vault: VaultState | MountedVaultState;
  supported: (path: string) => boolean;
  canApply: (path: string) => boolean;
  write: (paths: string[]) => void;
}
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
  private lifecycleBusy = false;
  private lifecycleUncertain = false;
  private operationEpoch = 0;
  private compositeUnsavedMoves = new Map<string, number>();
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
    private readonly syncBlocker?: SyncBlocker,
    private readonly persistLifecycle?: (snapshot: IosGitSyncSettings) => Promise<void>
  ) { captureLegacyContext(this.settings); }

  destinationBlocker(): string | null {
    if (this.lifecycleBusy || this.lifecycleUncertain) return "Local lifecycle operation active or save outcome uncertain; reload before recovery";
    return syncDestinationBlocker(this.settings);
  }

  lifecycleState(): IosGitSyncSettings { return cloneSettings(this.settings); }

  private assertEngine(epoch = this.operationEpoch): void {
    if (epoch !== this.operationEpoch) throw new Error("Binding operation invalidated; recovery evidence retained");
    const blocked = this.lifecycleBusy || this.lifecycleUncertain
      ? "Local lifecycle operation active or save outcome uncertain; reload before recovery" : lifecycleBlocker(this.settings);
    // Ordinary composite routing has its own destination checks; lifecycle gates apply to every engine.
    if (blocked) throw new Error(blocked);
  }

  private lifecycle(): LocalLifecycle {
    if (!this.persistLifecycle) throw new Error("Atomic settings persistence is unavailable");
    return new LocalLifecycle(this.vault, this.settings, async (snapshot) => {
      try { await this.persistLifecycle!(snapshot); }
      catch (error) { this.lifecycleUncertain = true; throw error; }
    });
  }

  private async lifecycleOperation(operation: (lifecycle: LocalLifecycle) => Promise<void>): Promise<void> {
    if (this.lifecycleBusy || this.lifecycleUncertain) throw new Error("Reload persisted settings before another lifecycle operation");
    this.lifecycleBusy = true;
    this.operationEpoch++;
    this.selectionRevision++;
    this.syncQueued = false;
    try {
      // Invalidate before waiting. A dispatched write may have committed, but cannot apply a late response.
      if (this.running) await new Promise<void>((resolve) => {
        const listener = (running: boolean) => { if (!running) { this.syncStateListeners.delete(listener); resolve(); } };
        this.syncStateListeners.add(listener);
      });
      await operation(this.lifecycle());
    } finally { this.lifecycleBusy = false; this.emitSyncState(); }
  }

  async detachBinding(mountId?: string): Promise<void> {
    await this.lifecycleOperation(async (lifecycle) => {
      await lifecycle.detach(mountId);
      if (mountId) this.compositeUnsavedMoves.delete(mountId);
    });
  }

  async recoverConversion(reverse = false): Promise<void> {
    await this.lifecycleOperation(async (lifecycle) => reverse ? lifecycle.reverse() : lifecycle.activate());
  }

  async previewConversion(targets: Array<{ shareId: string; localPrefix: string }>,
    mappings: Array<{ source: string; destination: string }>): Promise<ConversionPreview> {
    if (this.lifecycleBusy || this.lifecycleUncertain || this.settings.conversionGate) throw new Error("Recover or reload first");
    const shares = await this.discoverShares();
    const identity = { ...this.settings.authenticatedIdentity! };
    const config = await this.authConfig();
    const authentication = config.type === "oidc" ? `oidc:${config.issuer}` : config.type;
    const original = JSON.stringify(this.settings);
    const mounts = this.settings.composite?.mounts ?? [];
    assertMountPrefixes([...mounts, ...targets]);
    const proposed: CompositeState = { version: 1, revision: (this.settings.composite?.revision ?? 0) + 1,
      mounts: JSON.parse(JSON.stringify(mounts)), moves: JSON.parse(JSON.stringify(this.settings.composite?.moves ?? [])) };
    for (const target of targets) {
      const share = shares.find((entry) => entry.shareId === target.shareId);
      if (!share) throw new Error("Share unavailable or inaccessible");
      const state = await this.getJson<ShareSyncState>(`/v2/shares/${encodeURIComponent(target.shareId)}/sync-state`);
      if (state.shareId !== target.shareId || state.apiVersion !== 2 || !["read", "read-write"].includes(state.capability)) throw new Error("Invalid target negotiation");
      proposed.mounts.push({ ...share, capability: state.capability, serverUrl: identity.serverUrl, identity,
        authentication, mountId: createClientId(), localPrefix: target.localPrefix, moveGeneration: 0,
        initialized: false, status: "download-only", barriers: [], download: { observedHead: null, baseline: [],
          reconciliation: [], initial: { backupFolder: "", appliedPaths: [], complete: false } } });
    }
    if (JSON.stringify(this.settings) !== original) throw new Error("Configuration changed during preview; retry");
    const captured = await this.lifecycle().preview(proposed, mappings);
    return { configuration: original, proposed, mappings: captured,
      exclusions: this.vault.getFiles().map((file) => file.path).filter((path) => !captured.some((mapping) => mapping.source === path)) };
  }

  async convertBinding(preview: ConversionPreview): Promise<void> {
    if (JSON.stringify(this.settings) !== preview.configuration) throw new Error("Configuration changed since preview; preview again");
    // Read without acknowledging/clearing the original conflict state. Detachment is the explicit offline escape.
    if (!this.settings.composite && !this.settings.disabledBinding && !this.settings.pendingShareSelection &&
        (this.settings.activeShare || this.settings.initialSyncDone)) {
      const root = this.settings.activeShare ? this.sharePath(this.settings.activeShare) : this.vaultPath();
      const conflicts = await this.getJson<SyncConflict[]>(`${root}/conflicts?clientId=${encodeURIComponent(this.settings.clientId)}`);
      if (!Array.isArray(conflicts) || conflicts.length) throw new Error("Recover original server conflicts first, or explicitly detach the binding");
    }
    await this.lifecycleOperation(async (lifecycle) => {
      if (JSON.stringify(this.settings) !== preview.configuration) throw new Error("Configuration changed since preview; preview again");
      const original = this.settings.activeShare ?? this.settings.pendingShareSelection;
      if (original && (!original.download?.initial.complete || original.download.writing || original.download.applying ||
          original.download.reconciliation.length || original.download.serverConflicts?.length)) {
        throw new Error("Recover original binding journals and conflicts first, or explicitly detach it");
      }
      await lifecycle.plan(preview.proposed, preview.mappings);
      await lifecycle.activate();
    });
  }

  hasComposite(): boolean { return this.settings.composite !== undefined; }

  compositeMounts(): CompositeMount[] { return this.hasComposite() ? validateComposite(this.settings).mounts : []; }

  tracksLocalPath(path: string): boolean {
    return !this.hasComposite() || Boolean(resolveMount(validateComposite(this.settings), path));
  }

  hasLocalBarrier(path: string): boolean {
    if (!this.hasComposite()) return this.localReconciliations().some((entry) => entry.path === path);
    const resolved = resolveMount(validateComposite(this.settings), path);
    return Boolean(resolved && (mountPathBlocked(resolved.mount, resolved.path) ||
      resolved.mount.download.reconciliation.some((entry) => entry.path === resolved.path)));
  }

  private mountGuard(token: MountActionToken): () => void {
    const epoch = this.operationEpoch;
    return () => {
      this.assertEngine(epoch);
      if (this.compositeUnsavedMoves.has(token.mountId)) throw new Error("Move barrier persistence failed; retry synchronization to save recovery evidence");
      assertMountAction(this.settings, token);
    };
  }

  private vaultForShare(selected: PendingShareSelection | ActiveShare): VaultState | MountedVaultState {
    if (this.hasComposite()) {
      const mount = this.compositeMounts().find((entry) => entry === selected);
      if (!mount) throw new Error("Mount binding is unavailable");
      return new MountedVaultState(this.vault, mount.localPrefix);
    }
    return new VaultState(this.vault);
  }

  private selectedShare(mountId?: string): ActiveShare {
    const selected = this.hasComposite() ? this.compositeMounts().find((mount) => mount.mountId === mountId)
      : this.settings.activeShare;
    if (!selected) throw new Error("Select an initialized share or name a composite mount");
    return selected;
  }

  compositeActionGuard(mountId: string): () => void { return this.shareAction(this.selectedShare(mountId)).guard; }

  fileContext(localPath: string): FileContext | null {
    this.assertEngine();
    if (this.hasComposite()) {
      const resolved = resolveMount(validateComposite(this.settings), localPath);
      if (!resolved) return null;
      const token = captureMountAction(validateComposite(this.settings), resolved.mount);
      return { localPath, path: resolved.path, mountId: resolved.mount.mountId,
        ownership: { mountId: resolved.mount.mountId, shareId: resolved.mount.shareId, destination: token.destination },
        label: `${resolved.mount.localPrefix}/ - ${resolved.mount.label} (${resolved.mount.shareId})`, guard: this.mountGuard(token) };
    }
    if (!sharePathSupported(localPath)) return null;
    if (this.settings.activeShare) return { localPath, path: localPath,
      ownership: { mountId: `single:${this.settings.activeShare.shareId}`, shareId: this.settings.activeShare.shareId,
        destination: JSON.stringify([this.settings.activeShare.serverUrl, this.settings.activeShare.shareId,
          this.settings.activeShare.identity, this.settings.activeShare.authentication]) },
      label: `${this.settings.activeShare.label} (${this.settings.activeShare.shareId})`,
      guard: this.shareAction(this.settings.activeShare).guard };
    this.requireConfigured();
    const binding = JSON.stringify([this.settings.legacySyncBinding, this.settings.authenticatedIdentity]);
    const epoch = this.operationEpoch;
    return { localPath, path: localPath, label: `${this.settings.userSlug}/${this.settings.vaultSlug}`, guard: () => {
      this.assertEngine(epoch); this.requireConfigured();
      if (binding !== JSON.stringify([this.settings.legacySyncBinding, this.settings.authenticatedIdentity])) throw new Error("History binding changed");
    } };
  }

  snapshotOwnershipMatches(path: string, ownership?: HistoryOwnership): boolean {
    try {
      const context = this.fileContext(path);
      return Boolean(context && JSON.stringify(context.ownership) === JSON.stringify(ownership));
    } catch { return false; } // Detached/unavailable snapshots remain local evidence.
  }

  historyBarrierReason(context: FileContext): string | null {
    context.guard();
    if (!this.hasComposite() && !this.settings.activeShare) return null;
    const selected = this.selectedShare(context.mountId);
    const record = selected.download.reconciliation.find((entry) => entry.path === context.path);
    if (record) return record.reason;
    if (!selected.download.initial.complete) return "Initial reconciliation required";
    if (selected.download.applying?.path === context.path) return "Interrupted application requires recovery";
    if (selected.download.writing?.entries.some((entry) => entry.path === context.path)) return "Captured write outcome requires recovery";
    return this.hasLocalBarrier(context.localPath) ? "Move barrier requires explicit endpoint reconciliation in Manage mounts" : null;
  }

  private async historyDestination(path: string, captured?: FileContext): Promise<{ context: FileContext; root: string } | null> {
    const context = captured ?? this.fileContext(path);
    if (!context) return null;
    if (context.localPath !== path) throw new Error("History source changed");
    context.guard();
    const root = await this.readVaultPath(context.mountId, context.guard);
    context.guard();
    return { context, root };
  }

  compositeMoveDescription(moveId: string): string {
    const move = validateComposite(this.settings).moves.find((entry) => entry.id === moveId);
    if (!move) throw new Error("Move no longer exists");
    return `Detected move: ${move.from} -> ${move.to}`;
  }

  compositeLocalPath(mountId: string, path: string): string {
    return (this.vaultForShare(this.selectedShare(mountId)) as MountedVaultState).localPath(path);
  }

  /** Current committed bytes for a conflict choice, without opening the deferred history workflow. */
  async compositeConflictRemote(mountId: string, path: string): Promise<string> {
    const mount = this.selectedShare(mountId);
    const action = this.shareAction(mount);
    await this.negotiateShare(mount, action.guard);
    const snapshot = await this.shareSnapshot(mount); action.guard();
    if (!action.supported(path)) throw new Error("Unsupported conflict path");
    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file || file.op !== "upsert") throw new Error("No committed file remains; choose deletion explicitly");
    const bytes = await action.vault.serverBytes(file, (target) => this.downloadShareFile(mount, target, snapshot.serverHead));
    action.guard(); return arrayBufferToBase64(bytes);
  }

  /** One captured authority for the entire operation, including preparation, transport retries and acknowledgement. */
  private shareAction(selected: PendingShareSelection | ActiveShare,
    allowedBarriers: Array<{ moveId: string; path: string }> = []): ShareAction {
    const mount = this.hasComposite() ? selected as CompositeMount : undefined;
    const token = mount ? captureMountAction(validateComposite(this.settings), mount) : undefined;
    const epoch = this.operationEpoch;
    const check = token ? this.mountGuard(token) : () => this.assertShareContext(selected);
    const guard = () => { this.assertEngine(epoch); check(); };
    const canApply = (path: string) => !mount || !mount.barriers.some((barrier) =>
      (barrier.path === "" || path === barrier.path || path.startsWith(`${barrier.path}/`) || barrier.path.startsWith(`${path}/`)) &&
      !allowedBarriers.includes(barrier));
    const supported = mount ? compositePathSupported : sharePathSupported;
    return { token, guard, vault: this.vaultForShare(selected), supported, canApply,
      save: async () => { guard(); await this.saveSettings(); guard(); },
      write: (paths) => {
        guard();
        if (selected.capability !== "read-write" || selected.status !== "writable") throw new Error("Writable share access required");
        if (paths.some((path) => !supported(path) || !canApply(path))) throw new Error("Write blocked by mount path or move barrier");
      } };
  }

  async addCompositeMount(shareId: string, localPrefix: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.hasComposite()) {
        assertFreshCompositeVault(this.settings, this.vault);
        const root = await this.vault.adapter.list("");
        if (root.files.length || root.folders.some((folder) => folder !== ".obsidian")) {
          throw new Error("Composite setup requires a new empty vault; explicit conversion is required");
        }
      }
      const prior = this.settings.composite;
      const priorRevision = prior?.revision;
      const mounts = this.compositeMounts();
      assertMountPrefixes([...mounts, { shareId, localPrefix }]);
      const shares = await this.discoverShares();
      const share = shares.find((entry) => entry.shareId === shareId);
      if (!share) throw new Error("Share is unavailable or inaccessible");
      const identity = { ...this.settings.authenticatedIdentity! };
      const accessToken = this.settings.oidcAccessToken;
      const config = await this.authConfig();
      const authentication = config.type === "oidc" ? `oidc:${config.issuer}` : config.type;
      const response = await this.getJson<ShareSyncState>(`/v2/shares/${encodeURIComponent(shareId)}/sync-state`);
      if (prior !== this.settings.composite || priorRevision !== this.settings.composite?.revision ||
          accessToken !== this.settings.oidcAccessToken || identity.serverUrl !== serverIdentity(this.settings.serverUrl) ||
          JSON.stringify(identity) !== JSON.stringify(this.settings.authenticatedIdentity) || this.settings.userSlug !== identity.user) {
        throw new Error("Mount selection context changed; try again");
      }
      if (!prior) assertFreshCompositeVault(this.settings, this.vault);
      if (mounts.some((mount) => mount.serverUrl !== identity.serverUrl ||
          JSON.stringify(mount.identity) !== JSON.stringify(identity) || mount.authentication !== authentication)) {
        throw new Error("All mounts must use the original server and verified identity");
      }
      if (response.shareId !== shareId || response.apiVersion !== 2 || !["read", "read-write"].includes(response.capability)) {
        throw new Error("Invalid mount negotiation");
      }
      const mount: CompositeMount = { ...share, capability: response.capability, serverUrl: identity.serverUrl, identity,
        authentication, mountId: createClientId(), localPrefix, moveGeneration: 0, initialized: false,
        status: "download-only", barriers: [], download: { observedHead: null, baseline: [], reconciliation: [],
          initial: { backupFolder: "", appliedPaths: [], complete: false } } };
      this.settings.composite = { version: 1, revision: (priorRevision ?? 0) + 1,
        mounts: [...mounts, mount], moves: prior?.moves ?? [] };
      validateComposite(this.settings);
      await this.saveSettings();
    });
  }

  /** Post-mutation notification: invalidate synchronously, persist both endpoints before permitting more work. */
  async observeCompositeRename(from: string, to: string): Promise<void> {
    this.assertEngine();
    if (!this.hasComposite()) return;
    const state = validateComposite(this.settings);
    if (!recordCompositeMove(state, from, to, createClientId())) return;
    const generations = state.mounts.filter((mount) => state.moves[state.moves.length - 1].mountIds.includes(mount.mountId))
      .map((mount) => [mount.mountId, mount.moveGeneration] as const);
    for (const [id, generation] of generations) this.compositeUnsavedMoves.set(id, generation);
    try {
      await this.saveSettings();
      for (const [id, generation] of generations) {
        if (this.compositeUnsavedMoves.get(id) === generation) this.compositeUnsavedMoves.delete(id);
      }
    }
    catch { throw new Error("Move barrier could not be saved; affected synchronization stopped"); }
  }

  async initializeCompositeMount(mountId: string): Promise<void> {
    await this.exclusive(async () => {
      const mount = this.compositeMounts().find((entry) => entry.mountId === mountId);
      if (!mount) throw new Error("Mount not found");
      await this.attemptCompositeDownload(mount, !mount.initialized);
    });
  }

  private async attemptCompositeDownload(mount: CompositeMount, initial: boolean): Promise<void> {
    try { await this.downloadCompositeMount(mount, initial); }
    catch (error) {
      mount.lastError = error instanceof Error ? error.message : String(error);
      await this.saveSettings();
      throw error;
    }
  }

  private async downloadCompositeMount(mount: CompositeMount, initial: boolean): Promise<void> {
    const action = this.shareAction(mount);
    const { guard, vault } = action;
    guard();
    mount.lastAttemptAt = new Date().toISOString();
    mount.lastError = undefined;
    await this.saveSettings(); guard();
    await this.negotiateShare(mount, guard);
    guard();
    if (initial && !mount.download.initial.backupManifest) {
      mount.download.initial.backupFolder = `${this.recoveryFolder()}-${mount.mountId}`;
      await this.saveSettings(); guard();
      const backup = await vault.verifiedBackup(mount.download.initial.backupFolder, vault.paths());
      guard(); mount.download.initial.backupManifest = backup;
      await this.saveSettings(); guard();
    }
    const reconciler = new ShareReconciler(vault, mount.download, action.save,
      guard, action.supported, action.canApply);
    if (!initial) await reconciler.preserveLocalChanges();
    await this.downloadSnapshot(mount, initial, action);
    guard();
    mount.initialized = true;
    mount.download.lastDownloadedAt = new Date().toISOString();
    await this.saveSettings(); guard();
  }

  private async performCompositeSync(): Promise<SyncConflict[]> {
    const mounts = this.compositeMounts();
    const errors: string[] = [];
    const conflicts: SyncConflict[] = [];
    if (this.compositeUnsavedMoves.size) {
      const pending = new Map(this.compositeUnsavedMoves);
      try {
        await this.saveSettings();
        for (const [id, generation] of pending) {
          if (this.compositeUnsavedMoves.get(id) === generation) this.compositeUnsavedMoves.delete(id);
        }
      } catch (error) { errors.push(`Move evidence could not be saved: ${String(error)}`); }
    }
    for (const mount of mounts) {
      this.assertEngine();
      if (!mount.initialized) continue; // Background work cannot supply initial replacement consent.
      try {
        if (mount.status === "writable") {
          const action = this.shareAction(mount);
          action.guard(); mount.lastAttemptAt = new Date().toISOString(); mount.lastError = undefined;
          await action.save();
          const pending = await this.performShareSync(mount, action);
          conflicts.push(...pending.map((file) => ({ ...file, path: `${mount.localPrefix}/${file.path}` })));
        } else await this.attemptCompositeDownload(mount, false);
      }
      catch (error) {
        if (this.lifecycleBusy || this.lifecycleUncertain) throw error;
        mount.lastError = error instanceof Error ? error.message : String(error);
        await this.saveSettings();
        errors.push(`${mount.label}: ${mount.lastError ?? String(error)}`);
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
    new Notice(mounts.some((mount) => mount.initialized)
      ? "Composite synchronization complete; review per-mount status and barriers in Composite mounts."
      : "Open Composite mounts to explicitly initialize each download. Uploads remain disabled.");
    return conflicts;
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
    this.assertEngine();
    if (this.hasComposite()) throw new Error("Use Composite mounts; legacy selection is disabled");
    if (this.running) throw new Error("Wait for synchronization to finish before selecting a share");
    if (this.settings.activeShare || this.settings.pendingShareSelection?.download) {
      throw new Error("Existing share reconciliation state must be retained. Use a separate local vault for another share.");
    }
    const revision = ++this.selectionRevision;
    const shares = await this.discoverShares();
    this.assertEngine();
    const share = shares.find((entry) => entry.shareId === shareId);
    if (!share) throw new Error("Share is unavailable or inaccessible");
    const identity = { ...this.settings.authenticatedIdentity! };
    const token = this.settings.oidcAccessToken;
    const config = await this.authConfig();
    if (!["password", "oidc", "token"].includes(config.type)) throw new Error("Invalid authentication configuration");
    const state = await this.getJson<ShareSyncState>(`/v2/shares/${encodeURIComponent(share.shareId)}/sync-state`);
    this.assertEngine();
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
    this.assertEngine();
    if (this.running) throw new Error("Wait for synchronization to finish before cancelling a selection");
    if (this.settings.pendingShareSelection?.download) throw new Error("Initial download has started. Resume reconciliation; cancellation cannot safely restore v1 files.");
    ++this.selectionRevision;
    this.settings.pendingShareSelection = null;
    await this.saveSettings();
  }

  synchronizedManifest(): ManifestEntry[] {
    if (this.hasComposite()) return this.compositeMounts().flatMap((mount) => mount.download.baseline.map((entry) =>
      ({ ...entry, path: `${mount.localPrefix}/${entry.path}` })));
    return this.settings.activeShare?.download.baseline ?? this.settings.localManifest;
  }

  hasSelectedShare(): boolean { return this.hasComposite() || Boolean(this.settings.activeShare); }

  canWriteSelectedShare(mountId?: string): boolean {
    if (this.hasComposite()) {
      const mount = this.compositeMounts().find((entry) => entry.mountId === mountId);
      return Boolean(mount?.initialized && mount.status === "writable" && mount.capability === "read-write");
    }
    if (this.settings.pendingShareSelection) return false;
    const selected = this.settings.activeShare;
    return !selected || (selected.status === "writable" && selected.capability === "read-write");
  }

  lastSynchronizedAt(): string | null {
    if (this.hasComposite()) return null; // Per-mount times must not imply a vault-wide acknowledgement.
    return this.settings.activeShare?.download.lastDownloadedAt ?? (this.settings.activeShare ? null : this.settings.lastSyncedAt);
  }

  shareDownloadStatus(): string | null {
    if (this.hasComposite()) return this.compositeMounts().map((mount) =>
      `${mount.localPrefix}: ${mount.capability}, ${mount.initialized ? mount.status : "initial reconciliation required"}; ` +
      `${mount.download.reconciliation.length + mount.barriers.length} barrier(s)${mount.lastError ? "; retry required" : ""}`).join("; ");
    const selected = this.settings.activeShare;
    return selected ? `${selected.capability}, ${selected.status}; ${selected.download.reconciliation.length} local barrier(s)` : null;
  }

  /** Explicit opt-in after initial download. Existing preservation records remain upload barriers. */
  async enableShareWrites(mountId?: string): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.selectedShare(mountId);
      const action = this.shareAction(selected);
      if (!selected || !selected.download.initial.complete) throw new Error("Finish initial reconciliation first");
      await this.negotiateShare(selected, action.guard);
      if (selected.capability !== "read-write") throw new Error("Share is read-only");
      await this.downloadSnapshot(selected, false, action); // Recover applying journals before enabling any write path.
      await this.recoverShareWrite(selected, action);
      action.guard();
      const previous = selected.status;
      selected.status = "writable";
      try { await action.save(); }
      catch (error) { selected.status = previous; throw error; }
    });
  }

  localReconciliations(mountId?: string): LocalReconciliation[] {
    if (this.hasComposite()) return this.selectedShare(mountId).download.reconciliation;
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
    const current = this.hasComposite() ? this.compositeMounts().find((mount) => mount === selected)
      : this.settings.activeShare ?? this.settings.pendingShareSelection;
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

  private async readVaultPath(mountId?: string, guard?: () => void): Promise<string> {
    if (this.settings.activeShare || this.hasComposite()) {
      const selected = this.selectedShare(mountId);
      await this.negotiateShare(selected, guard ?? this.shareAction(selected).guard);
      return this.sharePath(selected);
    }
    this.requireConfigured();
    return this.vaultPath();
  }

  private async negotiateShare(selected: PendingShareSelection | ActiveShare,
    guard: () => void = () => this.assertShareContext(selected)): Promise<void> {
    guard();
    this.assertShareContext(selected);
    const info = await this.checkServerCompatibility();
    guard();
    if (!info.features?.includes("shareSyncV2")) throw new Error("Selected server no longer advertises shareSyncV2; no v1 fallback");
    const session = await this.getJson<AuthSessionResponse>("/v1/auth/session");
    guard();
    this.assertShareContext(selected);
    if (session.subject !== selected.identity.subject || session.user !== selected.identity.user) {
      throw new Error("Authenticated account differs from selected share state");
    }
    const config = await this.authConfig();
    guard();
    const authentication = config.type === "oidc" ? `oidc:${config.issuer}` : config.type;
    if (authentication !== selected.authentication) throw new Error("Authentication configuration changed; selected recovery state is retained");
    const state = await this.getJson<ShareSyncState>(`${this.sharePath(selected)}/sync-state`);
    guard();
    this.assertShareContext(selected);
    if (state.shareId !== selected.shareId || state.apiVersion !== 2 ||
        !["read", "read-write"].includes(state.capability)) throw new Error("Invalid share negotiation");
    const downgraded = selected.capability === "read-write" && state.capability === "read";
    selected.capability = state.capability;
    await this.saveSettings();
    guard();
    if (downgraded && selected.download) await new ShareReconciler(this.vaultForShare(selected), selected.download,
      async () => { guard(); await this.saveSettings(); guard(); }, guard,
      this.hasComposite() ? compositePathSupported : sharePathSupported,
      (path) => !this.hasComposite() || !mountPathBlocked(selected as CompositeMount, path)).preserveLocalChanges();
  }

  private async requireShareWrite(selected: PendingShareSelection | ActiveShare, action = this.shareAction(selected)): Promise<void> {
    await this.negotiateShare(selected, action.guard); action.guard();
    if (selected.capability !== "read-write") throw new Error("Share is read-only; local edits and recovery state retained");
  }

  private async shareWrite<T>(selected: PendingShareSelection | ActiveShare, path: string, body: unknown, action = this.shareAction(selected), paths: string[] = []): Promise<T> {
    await this.requireShareWrite(selected, action); action.write(paths);
    try { return (await this.requestWithAuth("POST", `${this.sharePath(selected)}${path}`, body, undefined, () => action.write(paths))).json as T; }
    catch (error) {
      if (error instanceof HttpStatusError && error.status === 403) {
        action.guard(); selected.capability = "read";
        await action.save();
        if (selected.download) await new ShareReconciler(action.vault, selected.download,
          action.save, action.guard, action.supported, action.canApply).preserveLocalChanges();
      }
      throw error;
    }
  }

  /** Recover unknown outcomes using remote contents, never by resending consumed upload IDs. */
  private async recoverShareWrite(selected: ActiveShare, action = this.shareAction(selected)): Promise<void> {
    const state = selected.download;
    const writing = state.writing;
    if (!writing) return;
    const response = await this.shareSnapshot(selected); action.guard();
    const pending = await this.readShareConflicts(selected, writing.entries.map((entry) => entry.path), action); action.guard();
    for (const sent of writing.entries) {
      const conflicted = pending.some((file) => file.path === sent.path);
      const remote = response.files.find((file) => file.path === sent.path) ?? { path: sent.path, op: "delete" as const };
      const matches = remote.op === "delete" ? sent.entry === null : sent.entry?.sha256 === remote.sha256;
      if (writing.stage !== "staging" && matches && !conflicted) {
        state.baseline = state.baseline.filter((entry) => entry.path !== sent.path);
        if (sent.entry) state.baseline.push(sent.entry);
      } else {
        let record = state.reconciliation.find((entry) => entry.path === sent.path);
        if (!record) state.reconciliation.push(record = { path: sent.path, baseline: state.baseline.find((entry) => entry.path === sent.path) ?? null,
          remote, remoteHead: response.serverHead, reason: "Interrupted write has an unconfirmed outcome; explicit reconciliation required",
          uploadBlocked: true });
        record.capturedWrite = { stage: writing.stage, entry: sent.entry, mountAction: writing.mountAction };
      }
    }
    delete state.writing;
    await action.save();
    await this.applyShareSnapshot(selected, response, false, action);
  }

  private async readShareConflicts(selected: ActiveShare, explicitlyHandled: string[] = [], action = this.shareAction(selected)): Promise<SyncConflict[]> {
    const pending = await this.getJson<SyncConflict[]>(`${this.sharePath(selected)}/conflicts?clientId=${encodeURIComponent(this.settings.clientId)}`);
    action.guard();
    if (!Array.isArray(pending) || pending.some((file) => typeof file.path !== "string" || typeof file.reason !== "string" ||
        !action.supported(file.path))) {
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
    await action.save();
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
    this.validateShareFiles(response.files);
    return response;
  }

  private validateShareFiles(files: ServerFileChange[]): void {
    const paths = new Set<string>();
    for (const file of files) {
      assertSafeVaultPath(file.path);
      if (file.op !== "delete" && (file.op !== "upsert" || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Invalid remote change");
      const key = this.hasComposite() ? pathKey(file.path) : file.path;
      if (paths.has(key)) throw new Error("Duplicate or aliased remote paths");
      paths.add(key);
    }
  }

  private async applyShareSnapshot(selected: PendingShareSelection | ActiveShare, response: SyncResponse, initial = false, action = this.shareAction(selected)): Promise<void> {
    action.guard();
    this.validateShareFiles(response.files);
    if (!selected.download) throw new Error("Missing explicit initial reconciliation");
    await new ShareReconciler(action.vault, selected.download, action.save,
      action.guard, action.supported, action.canApply).applySnapshot(response.files, response.serverHead,
      (file) => this.downloadShareFile(selected, file, response.serverHead), initial); action.guard();
  }

  private async downloadSnapshot(selected: PendingShareSelection | ActiveShare, initial = false, action = this.shareAction(selected)): Promise<void> {
    await this.applyShareSnapshot(selected, await this.shareSnapshot(selected), initial, action);
  }

  private async performShareSync(selected: ActiveShare = this.settings.activeShare!, action = this.shareAction(selected)): Promise<SyncConflict[]> {
    await this.negotiateShare(selected, action.guard);
    // Recover application and network journals before collecting a single new upload.
    if (selected.download.applying) await this.downloadSnapshot(selected, false, action);
    await this.recoverShareWrite(selected, action);
    if (selected.status !== "writable" || selected.capability !== "read-write") {
      if (this.hasComposite()) await this.downloadCompositeMount(selected as CompositeMount, false);
      else await this.performShareDownload(); return [];
    }
    await this.readShareConflicts(selected, [], action);
    const vault = action.vault;
    const paths = new Set([...vault.paths(), ...selected.download.baseline.map((entry) => entry.path)]);
    const captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }> = [];
    for (const path of paths) {
      if (!action.supported(path) || !action.canApply(path) || selected.download.reconciliation.some((entry) => entry.path === path) ||
          selected.download.serverConflicts?.some((entry) => entry.path === path)) continue;
      let file: { entry: ManifestEntry | null; bytes?: ArrayBuffer };
      try { file = await vault.capture(path); }
      catch (error) {
        const baseline = selected.download.baseline.find((entry) => entry.path === path) ?? null;
        selected.download.reconciliation.push({ path, baseline, remote: baseline
          ? { path, op: "upsert", sha256: baseline.sha256 } : { path, op: "delete" },
          remoteHead: selected.download.observedHead, reason: `Local upload state uncertain: ${String(error)}`, uploadBlocked: true });
        await action.save();
        continue;
      }
      if (!sameFile(file.entry, selected.download.baseline.find((entry) => entry.path === path) ?? null)) captured.push({ path, entry: file.entry });
    }
    if (captured.length) await this.submitShareChanges(selected, captured, selected.download.observedHead, false, action);
    await this.downloadSnapshot(selected, false, action);
    selected.download.lastDownloadedAt = new Date().toISOString();
    if (!this.hasComposite()) this.settings.lastSyncCompletedAt = selected.download.lastDownloadedAt;
    await action.save();
    const conflicts = selected.download.serverConflicts ?? [];
    if (conflicts.length) this.showConflictNotice(conflicts);
    else new Notice(`Share sync complete: ${captured.length} local change(s); ${selected.download.reconciliation.length} local barrier(s)`);
    return conflicts;
  }

  private async submitShareChanges(selected: ActiveShare,
    captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }>, baseHead: string | null,
    resolve = false, action = this.shareAction(selected)): Promise<void> {
    action.write(captured.map((file) => file.path));
    const state = selected.download;
    if (state.writing || state.applying) throw new Error("Recover interrupted work before writing");
    state.writing = { stage: "staging", entries: captured.map(({ path, entry }) => ({ path, entry })), mountAction: action.token };
    await action.save();
    const changes: ClientChange[] = [];
    for (const file of captured) {
      if (file.entry) {
        // Hold at most one staged file's bytes. A reread must still match the journaled capture.
        const bytes = file.bytes ?? (await action.vault.capture(file.path)).bytes;
        if (!bytes || await sha256Hex(bytes) !== file.entry.sha256) throw new Error(`Local file changed before staging: ${file.path}`);
        const uploadId = await this.uploadShareBuffer(selected, file.path, bytes, file.entry, action);
        changes.push({ path: file.path, op: "upsert", uploadId, sha256: file.entry.sha256, mtime: file.entry.mtime });
      } else changes.push({ path: file.path, op: "delete" });
    }
    action.write(captured.map((file) => file.path));
    state.writing.stage = "submitted";
    await action.save();
    const response = resolve
      ? await this.shareWrite<SyncResponse>(selected, "/resolve", {
        clientId: this.settings.clientId, deviceName: this.deviceName(), fileContent: this.fileContentMode(),
        files: changes.map((change) => change.op === "delete" ? { path: change.path, delete: true }
          : { path: change.path, uploadId: change.uploadId }) } satisfies ResolveRequest, action, captured.map((file) => file.path))
      : await this.shareWrite<SyncResponse>(selected, "/sync", {
        baseHead, clientId: this.settings.clientId, deviceName: this.deviceName(), changes,
        clientManifest: state.baseline, fileContent: this.fileContentMode() } satisfies SyncRequest, action, captured.map((file) => file.path));
    action.write(captured.map((file) => file.path));
    if (!["ok", "conflict"].includes(response.status) || !Array.isArray(response.conflicts) ||
        !Array.isArray(response.files)) throw new Error("Invalid write response; journal retained");
    this.validateShareFiles(response.files);
    if (response.conflicts.some((file) => typeof file.reason !== "string" || !action.supported(file.path))) {
      throw new Error("Invalid write conflicts; journal retained");
    }
    const unresolved = resolve ? (state.serverConflicts ?? []).filter((conflict) =>
      !captured.some((file) => file.path === conflict.path)) : [];
    state.serverConflicts = [...unresolved, ...response.conflicts.filter((conflict) =>
      !unresolved.some((file) => file.path === conflict.path))];
    if (response.status === "ok") {
      state.writing.stage = "accepted";
      await action.save();
      action.write(captured.map((file) => file.path));
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
        const vault = action.vault;
        const folder = this.recoveryFolder();
        await vault.verifiedBackup(folder, (await vault.checkedEntryFor(file.path)) ? [file.path] : []);
        action.write([file.path]);
        state.applying = { path: file.path, baseline: sent.entry, remote: file, remoteHead: response.serverHead,
          reason: "Interrupted server conflict display", uploadBlocked: true, backupFolder: folder };
        await action.save();
        const bytes = await vault.serverBytes(file, async () => { throw new Error("Conflict markers must be inline"); });
        if (!await vault.applyGuarded(file, sent.entry, bytes, () => action.write([file.path]))) {
          state.reconciliation.push({ ...state.applying, reason: "Local edit during conflict response; bytes retained" });
        }
        action.write([file.path]);
        delete state.applying;
        await action.save();
      }
    }
    action.write(captured.map((file) => file.path));
    delete state.writing;
    await action.save();
  }

  private async uploadShareBuffer(selected: ActiveShare, path: string, bytes: ArrayBuffer, entry: ManifestEntry, action = this.shareAction(selected)): Promise<string> {
    const init = await this.shareWrite<UploadInitResponse>(selected, "/uploads", { path, sha256: entry.sha256, size: bytes.byteLength }, action, [path]);
    const chunkSize = Math.max(1, Math.min(init.chunkSize || 512 * 1024, 2 * 1024 * 1024));
    for (let offset = 0; offset < bytes.byteLength;) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = await this.shareWrite<UploadChunkResponse>(selected, `/uploads/${encodeURIComponent(init.uploadId)}/chunk`,
        { offset, contentBase64: arrayBufferToBase64(bytes.slice(offset, end)) }, action, [path]);
      if (chunk.received !== end) throw new Error(`Invalid upload progress: ${path}`);
      offset = end;
    }
    const complete = await this.shareWrite<UploadCompleteResponse>(selected, `/uploads/${encodeURIComponent(init.uploadId)}/complete`, {}, action, [path]);
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

  async keepLocalReconciliation(path: string, mountId?: string): Promise<void> {
    if (this.running) throw new Error("Wait for synchronization to finish");
    const selected = this.hasComposite() ? this.selectedShare(mountId) : this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("No selected share");
    const action = this.shareAction(selected); action.guard();
    const record = this.localReconciliations(mountId).find((entry) => entry.path === path);
    if (!record) throw new Error("No local reconciliation record");
    record.localChoice = "keep-local";
    record.reason = "Local bytes retained by explicit choice; future upload still requires write reconciliation";
    await action.save();
  }

  /** An explicit, backed-up choice of current bytes against a freshly observed remote version. */
  async uploadLocalReconciliation(path: string, mountId?: string): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.selectedShare(mountId);
      await this.uploadLocalChoice(selected, path, this.shareAction(selected));
    });
  }

  private async uploadLocalChoice(selected: ActiveShare, path: string, action: ShareAction): Promise<void> {
    if (!selected || selected.status !== "writable") throw new Error("Enable writable share synchronization first");
    await this.requireShareWrite(selected, action);
    await this.recoverShareWrite(selected, action);
    await this.downloadSnapshot(selected, false, action);
    const record = selected.download.reconciliation.find((entry) => entry.path === path);
    if (!record) throw new Error("No local reconciliation record");
    if (selected.download.serverConflicts?.some((entry) => entry.path === path)) throw new Error("Use server conflict resolution for this path");
    const vault = action.vault;
    const file = await vault.capture(path);
    const folder = this.recoveryFolder();
    const copied = await vault.verifiedBackup(folder, file.entry ? [path] : []);
    if (!sameFile(copied[0] ?? null, file.entry)) throw new Error("File changed during reconciliation backup");
    action.write([path]); record.backupFolder = folder;
    await action.save();
    await this.submitShareChanges(selected, [{ path, ...file }], record.remoteHead, false, action);
    action.write([path]);
    if (!selected.download.serverConflicts?.some((entry) => entry.path === path)) {
      selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== path);
      await action.save();
    }
    await this.downloadSnapshot(selected, false, action);
  }

  /** Initial upload is an explicit replacement decision, with local backup and a real remote base. */
  async initializeShareUpload(mountId?: string): Promise<void> {
    if (this.hasComposite()) {
      await this.exclusive(async () => {
        const mount = this.selectedShare(mountId) as CompositeMount;
        const action = this.shareAction(mount);
        if (mount.initialized || mount.download.initial.backupManifest) throw new Error("Resume existing recovery; initial replacement cannot be repeated");
        await this.requireShareWrite(mount, action);
        const { snapshot, captured } = await this.prepareInitialUpload(mount, action);
        mount.initialized = true;
        mount.status = "writable";
        // Save the replacement captures together with activation: restart must never infer consent from a scan.
        if (captured.length) mount.download.writing = { stage: "staging", entries: captured, mountAction: action.token };
        try { await action.save(); }
        catch (error) { mount.initialized = false; mount.status = "download-only"; throw error; }
        if (captured.length) {
          delete mount.download.writing; // Already durable; submit installs the same captures before any network staging.
          await this.submitShareChanges(mount, captured, snapshot.serverHead, false, action);
        }
        await this.downloadSnapshot(mount, false, action);
        if (mount.download.serverConflicts?.length) throw new Error("Initial upload has server conflicts; resolve this mount explicitly");
        mount.download.lastDownloadedAt = new Date().toISOString();
        await action.save();
      });
      return;
    }
    await this.exclusive(async () => {
      const pending = this.settings.pendingShareSelection;
      if (!pending || pending.download) throw new Error("Select an uninitialized share; resume existing recovery instead");
      await this.requireShareWrite(pending);
      const { snapshot, captured, download } = await this.prepareInitialUpload(pending, this.shareAction(pending));
      const { syncState: _old, status: _status, observedHead: _head, ...destination } = pending;
      const selected: ActiveShare = { ...destination, status: "writable", download };
      this.settings.activeShare = selected;
      this.settings.pendingShareSelection = null;
      if (captured.length) download.writing = { stage: "staging", entries: captured };
      try { await this.saveSettings(); }
      catch (error) { selected.status = "download-only"; throw error; }
      if (captured.length) {
        delete download.writing;
        await this.submitShareChanges(selected, captured, snapshot.serverHead);
      }
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

  /** Initial replacement uses the same verified captures for single-share and composite destinations. */
  private async prepareInitialUpload(selected: PendingShareSelection | ActiveShare, action: ShareAction): Promise<{
    snapshot: SyncResponse; captured: Array<{ path: string; entry: ManifestEntry | null }>; download: ActiveShare["download"]
  }> {
    action.guard();
    selected.download ??= { observedHead: null, baseline: [], reconciliation: [],
      initial: { backupFolder: "", appliedPaths: [], complete: false } };
    const state = selected.download;
    state.initial.backupFolder = this.hasComposite()
      ? `${this.recoveryFolder()}-${(selected as CompositeMount).mountId}` : this.recoveryFolder();
    await action.save();
    const backup = await action.vault.verifiedBackup(state.initial.backupFolder, action.vault.paths().filter(action.supported));
    action.guard(); state.initial.backupManifest = backup;
    await action.save();
    const snapshot = await this.shareSnapshot(selected); action.guard();
    const captured: Array<{ path: string; entry: ManifestEntry | null }> = [];
    const paths = new Set([...backup.map((entry) => entry.path), ...snapshot.files.map((file) => file.path)]);
    for (const path of paths) {
      if (!action.supported(path)) continue;
      const local = await action.vault.capture(path); action.guard();
      if (!sameFile(local.entry, backup.find((entry) => entry.path === path) ?? null)) {
        throw new Error(`Local file changed after initial backup: ${path}. Resume safe download reconciliation.`);
      }
      const remote = snapshot.files.find((entry) => entry.path === path);
      if (local.entry?.sha256 !== (remote?.op === "upsert" ? remote.sha256 : undefined)) captured.push({ path, entry: local.entry });
    }
    state.baseline = snapshot.files.filter((file): file is ServerUpsert => file.op === "upsert" && action.supported(file.path))
      .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size ?? 0, mtime: 0 }));
    state.observedHead = snapshot.serverHead;
    state.initial.complete = true;
    return { snapshot, captured, download: state };
  }

  async useRemoteReconciliation(path: string, mountId?: string): Promise<void> {
    await this.exclusive(async () => {
      const selected = this.selectedShare(mountId);
      await this.useRemoteChoice(selected, path, this.shareAction(selected));
    });
  }

  private async useRemoteChoice(selected: ActiveShare, path: string, action: ShareAction): Promise<void> {
    if (!selected) throw new Error("Resume initial download before reconciling individual files");
    await this.negotiateShare(selected, action.guard);
    await this.downloadSnapshot(selected, false, action); // Refresh the target; never resolve a stale tombstone.
    action.guard();
    if (!action.canApply(path)) throw new Error("Reconcile the detected move endpoint first");
    if (selected.download.serverConflicts?.some((entry) => entry.path === path)) throw new Error("Resolve the server conflict first");
    const record = selected.download.reconciliation.find((entry) => entry.path === path);
    if (!record) return;
    const vaultState = action.vault;
    const backupFolder = this.recoveryFolder();
    const copied = await vaultState.verifiedBackup(backupFolder,
      (await vaultState.checkedEntryFor(path)) ? [path] : []);
    const expected = copied[0] ?? null;
    action.guard(); record.backupFolder = backupFolder;
    await action.save();
    const bytes = record.remote.op === "upsert" ? await vaultState.serverBytes(record.remote,
      (file) => this.downloadShareFile(selected, file, record.remoteHead)) : undefined;
    action.guard();
    selected.download.applying = record;
    await action.save();
    const applied = await vaultState.applyGuarded(record.remote, expected, bytes, () => {
      action.guard(); if (!action.canApply(path)) throw new Error("Move blocks local application");
    });
    action.guard();
    if (!applied) {
      record.reason = "Local file changed during reconciliation; bytes retained";
    } else {
      selected.download.baseline = selected.download.baseline.filter((entry) => entry.path !== path);
      if (record.remote.op === "upsert") selected.download.baseline.push({ path, sha256: record.remote.sha256,
        size: bytes!.byteLength, mtime: Date.now() });
      // The explicit remote choice discards the backed-up edit. It does not approve a local upload.
      selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== path);
    }
    delete selected.download.applying;
    await action.save();
    new Notice(`Local reconciliation processed for ${path}. Backup: ${backupFolder}`);
  }

  /** Consent is restricted to one recorded endpoint. The other endpoint remains independently blocked. */
  async reconcileCompositeMove(mountId: string, moveId: string, endpoint: string,
    choice: "keep-local" | "use-remote" | "upload-local"): Promise<void> {
    await this.exclusive(async () => {
      const mount = this.selectedShare(mountId) as CompositeMount;
      const barrier = mount.barriers.find((entry) => entry.moveId === moveId && entry.path === endpoint);
      if (!barrier) throw new Error("Move endpoint no longer exists");
      const recovery = this.shareAction(mount);
      await this.negotiateShare(mount, recovery.guard);
      if (mount.download.applying) await this.downloadSnapshot(mount, false, recovery);
      await this.recoverShareWrite(mount, recovery);
      const snapshot = await this.shareSnapshot(mount); recovery.guard();
      await this.readShareConflicts(mount, [], recovery);
      const action = this.shareAction(mount, [barrier]);
      const within = (path: string) => action.supported(path) &&
        (endpoint === "" || path === endpoint || path.startsWith(`${endpoint}/`));
      const localPaths = new Set(action.vault.paths());
      const paths = [...new Set([...localPaths, ...mount.download.baseline.map((file) => file.path),
        ...mount.download.reconciliation.map((file) => file.path), ...snapshot.files.map((file) => file.path)])].filter(within);
      const folder = this.recoveryFolder();
      const backup = await action.vault.verifiedBackup(folder, paths.filter((path) => localPaths.has(path)));
      action.guard();
      for (const path of paths) {
        if (choice !== "keep-local" && !action.canApply(path)) throw new Error("Another move barrier also covers this endpoint; retain local bytes first");
        const current = await action.vault.capture(path); action.guard();
        if (!sameFile(current.entry, backup.find((file) => file.path === path) ?? null)) throw new Error("Endpoint changed during backup");
        const previous = mount.download.reconciliation.find((file) => file.path === path);
        mount.download.reconciliation = mount.download.reconciliation.filter((file) => file.path !== path);
        mount.download.reconciliation.push({ path, baseline: mount.download.baseline.find((file) => file.path === path) ?? null,
          remote: snapshot.files.find((file) => file.path === path) ?? { path, op: "delete" }, remoteHead: snapshot.serverHead,
          reason: "Explicit move endpoint reconciliation; other endpoints remain blocked", uploadBlocked: true,
          capturedWrite: previous?.capturedWrite,
          backupFolder: folder, ...(choice === "keep-local" ? { localChoice: "keep-local" as const } : {}) });
      }
      await action.save(); // Durable local barriers precede every endpoint decision.
      for (const path of paths) {
        if (choice === "use-remote") await this.useRemoteChoice(mount, path, action);
        if (choice === "upload-local") await this.uploadLocalChoice(mount, path, action);
      }
      action.guard();
      if (choice !== "keep-local" && paths.some((path) => mount.download.reconciliation.some((file) => file.path === path) ||
          mount.download.serverConflicts?.some((file) => file.path === path))) throw new Error("Endpoint still has unresolved outcomes; move barrier retained");
      const state = validateComposite(this.settings);
      const move = state.moves.find((entry) => entry.id === moveId)!;
      mount.barriers = mount.barriers.filter((entry) => entry !== barrier);
      if (!mount.barriers.some((entry) => entry.moveId === moveId)) move.mountIds = move.mountIds.filter((id) => id !== mountId);
      if (!move.mountIds.length) state.moves = state.moves.filter((entry) => entry !== move);
      try { await action.save(); }
      catch (error) {
        if (!mount.barriers.includes(barrier)) mount.barriers.push(barrier);
        if (!move.mountIds.includes(mountId)) move.mountIds.push(mountId);
        if (!state.moves.includes(move)) state.moves.push(move);
        throw error;
      }
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
    if (this.hasComposite()) {
      let upserts = 0, deletes = 0;
      for (const mount of this.compositeMounts()) {
        const manifest = await this.vaultForShare(mount).computeManifest();
        const diff = diffManifests(manifest, mount.download.baseline);
        upserts += diff.upsertPaths.length + mount.barriers.length;
        deletes += diff.deletePaths.length;
      }
      return { changed: upserts + deletes, upserts, deletes };
    }
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
    if (this.lifecycleBusy || this.lifecycleUncertain || this.settings.conversionGate) return false;
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
    this.assertEngine();
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
    if (this.hasComposite()) return this.performCompositeSync();
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

  async history(path?: string, captured?: FileContext): Promise<HistoryEntry[]> {
    if (!path) return this.getJson<HistoryEntry[]>(`${await this.readVaultPath()}/history`);
    const destination = await this.historyDestination(path, captured);
    if (!destination) return [];
    const { context, root } = destination;
    const result = await this.getJson<HistoryEntry[]>(`${root}/history?path=${encodeURIComponent(context.path)}`);
    context.guard(); return result;
  }

  async devices(mountId?: string): Promise<DeviceEntry[]> {
    const guard = this.hasComposite() ? this.compositeActionGuard(mountId!) : undefined;
    const root = await this.readVaultPath(mountId, guard);
    const result = await this.getJson<DeviceEntry[]>(`${root}/devices`);
    guard?.(); return result;
  }

  async deviceVersions(path: string, captured?: FileContext): Promise<DeviceVersionEntry[]> {
    const destination = await this.historyDestination(path, captured);
    if (!destination) return [];
    const { context, root } = destination;
    try {
      const result = await this.getJson<DeviceVersionEntry[]>(`${root}/files/device-versions?path=${encodeURIComponent(context.path)}`);
      context.guard(); return result;
    } catch (error) {
      if (this.settings.activeShare || this.hasComposite()) throw error;
      // Older servers don't have this endpoint yet; degrade to no badges.
      return [];
    }
  }

  async saveVersionMetadata(request: VersionMetadataRequest, captured?: FileContext): Promise<void> {
    const context = captured ?? this.fileContext(request.path);
    if (!context || context.localPath !== request.path) throw new Error("Local-only or mismatched metadata source");
    context.guard();
    if (this.settings.activeShare || this.hasComposite()) {
      const selected = this.selectedShare(context.mountId);
      if (!this.canWriteSelectedShare(context.mountId)) throw new Error("Share metadata is read-only");
      const action = this.shareAction(selected);
      await this.shareWrite(selected, "/files/version-metadata", { ...request, path: context.path },
        { ...action, guard: () => { context.guard(); action.guard(); } }, [context.path]);
      return;
    }
    this.requireConfigured();
    await this.postJson<void>(`${this.vaultPath()}/files/version-metadata`, request);
  }

  async fileAtVersion(path: string, hash: string, captured?: FileContext): Promise<VersionFileResponse> {
    const destination = await this.historyDestination(path, captured);
    if (!destination) throw new Error("Local-only files have no remote history");
    const { context, root } = destination;
    const file = await this.getJson<VersionFileResponse>(`${root}/file?path=${encodeURIComponent(context.path)}&hash=${encodeURIComponent(hash)}`);
    context.guard();
    if ((this.settings.activeShare || this.hasComposite()) && (file.path !== context.path || file.hash !== hash ||
        await sha256Hex(base64ToArrayBuffer(file.contentBase64)) !== file.sha256)) {
      throw new Error(`History download checksum mismatch: ${path}`);
    }
    context.guard(); return file;
  }

  async blobAtVersion(path: string, hash: string, captured?: FileContext): Promise<ArrayBuffer> {
    const context = captured ?? this.fileContext(path);
    if (!context) throw new Error("Local-only files have no remote blobs");
    const metadata = await this.fileAtVersion(path, hash, context);
    const destination = await this.historyDestination(path, context);
    const bytes = await this.requestBinary("GET", `${destination!.root}/blob?path=${encodeURIComponent(context.path)}&hash=${encodeURIComponent(hash)}`);
    context.guard();
    if (await sha256Hex(bytes) !== metadata.sha256) throw new Error("Historical blob checksum mismatch");
    context.guard(); return bytes;
  }

  async restoreHistoricalFile(path: string, hash: string, captured?: FileContext): Promise<void> {
    const context = captured ?? this.fileContext(path);
    if (!context || context.localPath !== path || (!this.hasComposite() && !this.settings.activeShare)) {
      throw new Error("Historical restoration requires an owning initialized share");
    }
    context.guard();
    await this.exclusive(async () => {
      context.guard();
      const selected = this.selectedShare(context.mountId), action = this.shareAction(selected);
      if (!action.canApply(context.path)) throw new Error("Reconcile the move barrier before historical restoration");
      if (!selected.download.initial.complete || selected.download.applying || selected.download.writing) {
        throw new Error("Recover existing initialization/application/write work before historical restoration");
      }
      const before = await action.vault.checkedEntryFor(context.path);
      const version = await this.fileAtVersion(path, hash, context);
      const bytes = base64ToArrayBuffer(version.contentBase64);
      const backupFolder = this.recoveryFolder();
      await action.vault.verifiedBackup(backupFolder, before ? [context.path] : []);
      context.guard();
      const record: LocalReconciliation = { path: context.path,
        baseline: selected.download.baseline.find((entry) => entry.path === context.path) ?? null,
        remote: { path: context.path, op: "upsert", sha256: version.sha256, size: bytes.byteLength },
        remoteHead: hash, reason: "Historical contents restored locally; explicit reconciliation required", uploadBlocked: true, backupFolder };
      if (!selected.download.reconciliation.some((entry) => entry.path === context.path)) selected.download.reconciliation.push(record);
      selected.download.applying = record;
      await action.save(); context.guard();
      if (!await action.vault.applyGuarded(record.remote, before, bytes, () => { context.guard(); action.guard(); })) {
        throw new Error("Local contents changed during historical restoration; copies and barrier retained");
      }
      context.guard(); delete selected.download.applying; await action.save();
    });
  }

  /**
   * Pushes one or more conflict resolutions in a single request and returns the conflicts the
   * server still reports afterwards (empty when everything was accepted).
   */
  async resolveConflicts(resolutions: ConflictResolution[], mountId?: string): Promise<SyncConflict[]> {
    if (resolutions.length === 0) return [];
    if (this.running) {
      throw new Error("A sync is running. Wait for it to finish, then try again.");
    }
    if (this.settings.activeShare || this.hasComposite()) {
      const result = await this.exclusive(async () => {
        const selected = this.selectedShare(mountId);
        const action = this.shareAction(selected);
        if (!this.canWriteSelectedShare(mountId)) throw new Error("Server conflict resolution requires writable share access");
        await this.requireShareWrite(selected, action);
        if (selected.download.applying) await this.downloadSnapshot(selected, false, action);
        await this.recoverShareWrite(selected, action);
        const pending = await this.readShareConflicts(selected, [], action);
        const vault = action.vault;
        const captured: Array<{ path: string; entry: ManifestEntry | null; bytes?: ArrayBuffer }> = [];
        for (const resolution of resolutions) {
          if (!action.supported(resolution.path) || !action.canApply(resolution.path) || !pending.some((entry) => entry.path === resolution.path)) {
            throw new Error("Only supported pending server conflicts may be resolved");
          }
          action.write([resolution.path]);
          const original = await vault.capture(resolution.path);
          const folder = this.recoveryFolder();
          const copied = await vault.verifiedBackup(folder, original.entry ? [resolution.path] : []);
          if (!sameFile(copied[0] ?? null, original.entry)) throw new Error("File changed during resolution backup");
          action.write([resolution.path]);
          if (resolution.kind !== "current") {
            const bytes = resolution.kind === "text" ? new TextEncoder().encode(resolution.content).buffer
              : resolution.kind === "binary" ? base64ToArrayBuffer(resolution.contentBase64) : undefined;
            const target: ServerFileChange = bytes ? { path: resolution.path, op: "upsert", sha256: await sha256Hex(bytes) }
              : { path: resolution.path, op: "delete" };
            selected.download.applying = { path: resolution.path, baseline: original.entry, remote: target,
              remoteHead: selected.download.observedHead, reason: "Interrupted explicit conflict choice", uploadBlocked: true, backupFolder: folder };
            await action.save();
            if (!await vault.applyGuarded(target, original.entry, bytes, () => action.write([resolution.path]))) {
              throw new Error("Local edit during resolution; bytes retained");
            }
            action.write([resolution.path]);
            delete selected.download.applying;
            await action.save();
          }
          captured.push({ path: resolution.path, entry: (await vault.capture(resolution.path)).entry });
        }
        await this.submitShareChanges(selected, captured, selected.download.observedHead, true, action);
        const remaining = await this.readShareConflicts(selected, captured.map((file) => file.path), action);
        for (const file of captured) if (!remaining.some((entry) => entry.path === file.path)) {
          selected.download.reconciliation = selected.download.reconciliation.filter((entry) => entry.path !== file.path);
        }
        await action.save();
        await this.downloadSnapshot(selected, false, action);
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
  async pendingConflicts(mountId?: string): Promise<SyncConflict[]> {
    if (this.settings.activeShare || this.hasComposite()) {
      const selected = this.selectedShare(mountId);
      const action = this.shareAction(selected);
      await this.negotiateShare(selected, action.guard);
      return this.readShareConflicts(selected, [], action);
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
  credentialContextKey(mountId?: string): string {
    return JSON.stringify([serverIdentity(this.settings.serverUrl), this.settings.userSlug,
      this.settings.authenticatedIdentity, this.settings.oidcAccessToken, this.settings.legacyManagementContext,
      this.operationEpoch, this.settings.composite?.revision,
      this.settings.composite?.mounts.map((mount) => [mount.mountId, mount.moveGeneration, captureMountAction(this.settings.composite!, mount).destination]), mountId,
      (this.settings.activeShare ?? this.settings.pendingShareSelection)?.shareId]);
  }

  private credentialGuard(mountId?: string): () => void {
    const key = this.credentialContextKey(mountId);
    return () => {
      if (this.lifecycleBusy || this.lifecycleUncertain || this.settings.conversionGate || key !== this.credentialContextKey(mountId)) {
        throw new Error("Credential action is stale; reopen its original context");
      }
    };
  }

  async legacyCredentialInventory(): Promise<{ entries: DevicePasswordEntry[]; managementAllowed: boolean }> {
    const context = this.legacyCredentialContext();
    const guard = this.credentialGuard();
    const response = await this.devicePasswordRequest(() =>
      this.requestWithAuth("GET", this.legacyCredentialPath(context), undefined, context, guard));
    const header = Object.entries(response.headers ?? {}).find(([key]) =>
      key.toLowerCase() === "x-obsidisync-legacy-grant-management")?.[1];
    return { entries: response.json as DevicePasswordEntry[], managementAllowed: header === "allowed" };
  }

  private legacyCredentialPath(context: LegacyManagementContext): string {
    return `/v1/users/${encodeURIComponent(context.userSlug)}/vaults/${encodeURIComponent(context.vaultSlug)}/device-passwords`;
  }

  async createDevicePassword(label: string, folder: string): Promise<CreatedDevicePassword> {
    const context = this.legacyCredentialContext();
    const guard = this.credentialGuard();
    const inventory = await this.legacyCredentialInventory(); guard();
    if (!inventory.managementAllowed) throw new Error("Legacy grant management requires an explicit allowed header; ask the host operator");
    const request: CreateDevicePasswordRequest = { label, folder };
    const response = await this.devicePasswordRequest(() =>
      this.requestWithAuth("POST", this.legacyCredentialPath(context), request, context, guard));
    return response.json as CreatedDevicePassword;
  }

  async revokeDevicePassword(id: string): Promise<void> {
    const context = this.legacyCredentialContext();
    const guard = this.credentialGuard();
    const inventory = await this.legacyCredentialInventory(); guard();
    if (!inventory.managementAllowed) throw new Error("Legacy grant management requires an explicit allowed header; ask the host operator");
    await this.devicePasswordRequest(() => this.requestWithAuth("DELETE",
      `${this.legacyCredentialPath(context)}/${encodeURIComponent(id)}`, undefined, context, guard));
  }

  private credentialShare(mountId?: string): PendingShareSelection | ActiveShare {
    const selected = this.hasComposite() ? this.selectedShare(mountId) : this.settings.activeShare ?? this.settings.pendingShareSelection;
    if (!selected) throw new Error("Choose a share to manage share-native grants");
    return selected;
  }

  async shareCredentialInventory(mountId?: string): Promise<{ shareId: string; capability: "read" | "read-write";
      entries: ShareCredentialEntry[] }> {
    const selected = this.credentialShare(mountId);
    const action = this.shareAction(selected), credentialGuard = this.credentialGuard(mountId);
    const guard = () => { action.guard(); credentialGuard(); };
    await this.negotiateShare(selected, guard);
    const entries = await this.getJson<ShareCredentialEntry[]>(`${this.sharePath(selected)}/device-passwords`);
    guard();
    return { shareId: selected.shareId, capability: selected.capability, entries };
  }

  async createShareCredential(label: string, folder: string, capability: "read" | "read-write", mountId?: string):
      Promise<CreatedShareCredential> {
    const selected = this.credentialShare(mountId);
    const action = this.shareAction(selected), credentialGuard = this.credentialGuard(mountId);
    const guard = () => { action.guard(); credentialGuard(); };
    await this.negotiateShare(selected, guard);
    if (capability !== "read" && capability !== "read-write") throw new Error("Invalid credential capability");
    if (capability === "read-write" && selected.capability !== "read-write") throw new Error("Share is read-only");
    const response = await this.requestWithAuth("POST", `${this.sharePath(selected)}/device-passwords`, { label, folder, capability }, undefined, guard);
    guard(); return response.json as CreatedShareCredential;
  }

  async revokeShareCredential(id: string, mountId?: string): Promise<void> {
    const selected = this.credentialShare(mountId);
    const action = this.shareAction(selected), credentialGuard = this.credentialGuard(mountId);
    const guard = () => { action.guard(); credentialGuard(); };
    await this.negotiateShare(selected, guard);
    if (selected.capability !== "read-write") throw new Error("Read-only membership requires host-operator revocation.");
    await this.requestWithAuth("DELETE", `${this.sharePath(selected)}/device-passwords/${encodeURIComponent(id)}`, undefined, undefined, guard);
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
      legacyCredential?: LegacyManagementContext, dispatchGuard?: () => void): Promise<RequestUrlResponse> {
    const epoch = this.operationEpoch;
    const selected = path.startsWith("/v2/shares/") ? (this.hasComposite()
      ? this.compositeMounts().find((mount) => path.startsWith(`/v2/shares/${encodeURIComponent(mount.shareId)}/`))
      : this.settings.activeShare ?? this.settings.pendingShareSelection) : null;
    const mountToken = selected && this.hasComposite()
      ? captureMountAction(validateComposite(this.settings), selected as CompositeMount) : null;
    const legacyAccount = legacyCredential ? JSON.stringify([this.settings.userSlug, this.settings.authenticatedIdentity]) : null;
    const assertDestination = () => {
      if (path.startsWith("/v1/users/") || path.startsWith("/v2/shares/")) {
        if (epoch !== this.operationEpoch || this.lifecycleBusy || this.lifecycleUncertain || this.settings.conversionGate) {
          throw new Error("Binding request invalidated by local lifecycle operation");
        }
      }
      dispatchGuard?.();
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
      if (mountToken) this.mountGuard(mountToken)();
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
    this.assertEngine();
    if (this.running) {
      new Notice("Git sync is already running");
      return undefined;
    }

    this.running = true;
    this.settings.syncStatus = "running";
    this.settings.lastSyncAttemptAt = new Date().toISOString();
    this.settings.lastSyncError = null;
    try {
      await this.saveSettings();
      this.emitSyncState();
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
