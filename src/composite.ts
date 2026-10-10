import type { Vault } from "obsidian";
import type { IosGitSyncSettings } from "./settings";
import type { ActiveShare } from "./shareReconciliation";
import type { ManifestEntry } from "./protocol";
import { sharePathSupported } from "./shareReconciliation";
import { assertSafeLocalPath, assertSafeVaultPath } from "./security";
import { serverIdentity } from "./shareSelection";

export interface CompositeMount extends ActiveShare {
  mountId: string;
  localPrefix: string;
  moveGeneration: number;
  initialized: boolean;
  barriers: Array<{ moveId: string; path: string }>;
  status: "download-only";
  lastAttemptAt?: string;
  lastError?: string;
}

export interface CompositeState {
  version: 1;
  revision: number;
  mounts: CompositeMount[];
  moves: Array<{ id: string; from: string; to: string; mountIds: string[] }>;
}

export interface MountActionToken {
  mountId: string;
  destination: string;
  revision: number;
  moveGeneration: number;
}

const reserved = new Set([".git", ".obsidian", ".obsidian-git-sync", ".trash", "obsidisync history"]);
export const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();
export const containsPath = (parent: string, path: string): boolean => parent === "" || path === parent || path.startsWith(`${parent}/`);

export function compositePathSupported(path: string): boolean {
  assertSafeLocalPath(path);
  return sharePathSupported(path) && !path.split("/").some((part) => reserved.has(pathKey(part))) &&
    pathKey(path.split("/")[0]) !== ".inkvault";
}

export function assertMountPrefixes(mounts: Array<{ localPrefix: string; shareId: string }>): void {
  const prefixes: string[] = [];
  const shares = new Set<string>();
  for (const mount of mounts) {
    assertSafeVaultPath(mount.localPrefix);
    if (!compositePathSupported(mount.localPrefix) || !/^s_[a-f0-9]{32}$/.test(mount.shareId)) {
      throw new Error("Invalid mount prefix or share ID");
    }
    const key = pathKey(mount.localPrefix);
    if (shares.has(mount.shareId) || prefixes.some((prefix) => containsPath(prefix, key) || containsPath(key, prefix))) {
      throw new Error("Mount prefixes overlap or alias, or share is mounted twice");
    }
    prefixes.push(key); shares.add(mount.shareId);
  }
}

export function resolveMount(state: CompositeState, path: string): { mount: CompositeMount; path: string } | null {
  assertSafeLocalPath(path);
  if (!compositePathSupported(path)) return null;
  for (const mount of state.mounts) {
    if (path.startsWith(`${mount.localPrefix}/`)) {
      const relative = path.slice(mount.localPrefix.length + 1);
      return compositePathSupported(relative) ? { mount, path: relative } : null;
    }
    if (containsPath(pathKey(mount.localPrefix), pathKey(path))) {
      if (path !== mount.localPrefix) throw new Error("Local path aliases a mount prefix");
    }
  }
  return null;
}

export function mountDestination(mount: CompositeMount): string {
  return JSON.stringify([mount.serverUrl, mount.shareId, mount.identity, mount.authentication, mount.localPrefix]);
}

export function captureMountAction(state: CompositeState, mount: CompositeMount): MountActionToken {
  return { mountId: mount.mountId, destination: mountDestination(mount), revision: state.revision,
    moveGeneration: mount.moveGeneration };
}

export function assertMountAction(settings: IosGitSyncSettings, token: MountActionToken): CompositeMount {
  const state = validateComposite(settings);
  const mount = state.mounts.find((entry) => entry.mountId === token.mountId);
  if (!mount || state.revision !== token.revision || mount.moveGeneration !== token.moveGeneration ||
      mountDestination(mount) !== token.destination || mount.serverUrl !== serverIdentity(settings.serverUrl) ||
      JSON.stringify(mount.identity) !== JSON.stringify(settings.authenticatedIdentity) ||
      settings.userSlug !== mount.identity.user) throw new Error("Mount action is stale; recovery state retained");
  return mount;
}

export function mountPathBlocked(mount: CompositeMount, path: string): boolean {
  return mount.barriers.some((barrier) => containsPath(barrier.path, path) || containsPath(path, barrier.path));
}

/** Validate before dispatch, including persisted per-file ownership. Unknown schemas never become v1 defaults. */
export function validateComposite(settings: IosGitSyncSettings): CompositeState {
  const state = settings.composite;
  const invalid = (): never => { throw new Error("Invalid composite state; synchronization stopped, no v1 fallback"); };
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1 ||
      !Array.isArray(state.mounts) || !state.mounts.length || !Array.isArray(state.moves) ||
      settings.activeShare || settings.pendingShareSelection) return invalid();
  if (state.mounts.some((mount) => !mount || typeof mount.localPrefix !== "string" || typeof mount.shareId !== "string") ||
      state.moves.some((move) => !move || typeof move.id !== "string" || !move.id ||
        typeof move.from !== "string" || typeof move.to !== "string" || !Array.isArray(move.mountIds) ||
        !move.mountIds.length || move.mountIds.some((id) => typeof id !== "string"))) return invalid();
  if (new Set(state.moves.map((move) => move.id)).size !== state.moves.length) return invalid();
  assertMountPrefixes(state.mounts);
  const ids = new Set<string>();
  let binding: string | undefined;
  const path = (value: unknown): void => {
    if (typeof value !== "string" || !compositePathSupported(value)) invalid();
  };
  const manifest = (entries: unknown): void => {
    if (!Array.isArray(entries)) invalid();
    const keys = new Set<string>();
    for (const entry of entries as ManifestEntry[]) {
      path(entry?.path);
      const key = pathKey(entry.path);
      if (keys.has(key) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isFinite(entry.size) ||
          entry.size < 0 || !Number.isFinite(entry.mtime)) invalid();
      keys.add(key);
    }
  };
  for (const mount of state.mounts) {
    if (!mount || typeof mount.mountId !== "string" || !mount.mountId || ids.has(mount.mountId) ||
        !Number.isSafeInteger(mount.moveGeneration) || mount.moveGeneration < 0 || typeof mount.initialized !== "boolean" ||
        mount.status !== "download-only" || !["read", "read-write"].includes(mount.capability) ||
        typeof mount.label !== "string" || !mount.identity || typeof mount.identity.subject !== "string" ||
        !mount.identity.subject || typeof mount.identity.user !== "string" || !mount.identity.user ||
        typeof mount.serverUrl !== "string" || mount.serverUrl !== serverIdentity(mount.serverUrl) ||
        mount.identity.serverUrl !== mount.serverUrl || typeof mount.authentication !== "string" ||
        !Array.isArray(mount.barriers)) invalid();
    ids.add(mount.mountId);
    const destination = JSON.stringify([mount.serverUrl, mount.identity, mount.authentication]);
    if (binding && binding !== destination) invalid();
    binding = destination;
    const download = mount.download;
    if (!download || !(download.observedHead === null || typeof download.observedHead === "string") ||
        !download.initial || typeof download.initial.complete !== "boolean" ||
        typeof download.initial.backupFolder !== "string" ||
        !Array.isArray(download.initial.appliedPaths) || !Array.isArray(download.reconciliation) ||
        (download.serverConflicts !== undefined && !Array.isArray(download.serverConflicts)) || download.writing) invalid();
    manifest(download.baseline);
    if (download.initial.backupManifest) manifest(download.initial.backupManifest);
    if (download.initial.backupFolder && !download.initial.backupFolder.startsWith(".obsidian-git-sync/backups/")) invalid();
    if (download.initial.backupFolder) assertSafeVaultPath(download.initial.backupFolder);
    if (mount.initialized && (!download.initial.complete || !download.initial.backupManifest)) invalid();
    for (const applied of download.initial.appliedPaths) path(applied);
    for (const record of [...download.reconciliation, ...(download.applying ? [download.applying] : [])]) {
      path(record?.path);
      if (record.uploadBlocked !== true || typeof record.reason !== "string" || !record.remote || record.remote.path !== record.path ||
          !["upsert", "delete"].includes(record.remote.op)) invalid();
      if (record.remote.op === "upsert" && !/^[a-f0-9]{64}$/.test(record.remote.sha256)) invalid();
      if (record.baseline) manifest([record.baseline]);
      if (record.baseline && record.baseline.path !== record.path) invalid();
    }
    for (const conflict of download.serverConflicts ?? []) path(conflict.path);
    for (const barrier of mount.barriers) {
      if (!barrier || typeof barrier.moveId !== "string") invalid();
      if (barrier.path !== "") assertSafeLocalPath(barrier.path);
      if (!state.moves.some((move) => move.id === barrier.moveId && move.mountIds.includes(mount.mountId))) invalid();
    }
  }
  for (const move of state.moves) {
    if (!move || typeof move.id !== "string" || !Array.isArray(move.mountIds) ||
        move.mountIds.some((id) => !ids.has(id))) invalid();
    if (move.mountIds.some((id) => !state.mounts.find((mount) => mount.mountId === id)!.barriers.some((barrier) => barrier.moveId === move.id))) invalid();
    assertSafeLocalPath(move.from); assertSafeLocalPath(move.to);
  }
  return state;
}

/** Immediate invalidation precedes the caller's asynchronous serialized persistence. */
export function recordCompositeMove(state: CompositeState, from: string, to: string, id: string): boolean {
  assertSafeLocalPath(from); assertSafeLocalPath(to);
  const source = resolveMount(state, from), destination = resolveMount(state, to);
  if (source && destination && source.mount === destination.mount) return false;
  const endpoints = [from, to];
  const affected = state.mounts.filter((mount) => endpoints.some((endpoint) =>
    containsPath(pathKey(mount.localPrefix), pathKey(endpoint)) || containsPath(pathKey(endpoint), pathKey(mount.localPrefix))));
  if (!affected.length) return false;
  state.moves.push({ id, from, to, mountIds: affected.map((mount) => mount.mountId) });
  for (const mount of affected) {
    mount.moveGeneration += 1;
    for (const endpoint of endpoints) {
      if (containsPath(pathKey(endpoint), pathKey(mount.localPrefix))) mount.barriers.push({ moveId: id, path: "" });
      else if (containsPath(pathKey(mount.localPrefix), pathKey(endpoint))) {
        mount.barriers.push({ moveId: id, path: endpoint.slice(mount.localPrefix.length + 1) });
      }
    }
  }
  return true;
}

export function assertFreshCompositeVault(settings: IosGitSyncSettings, vault: Vault): void {
  if (settings.activeShare || settings.pendingShareSelection || settings.initialSyncDone || settings.serverHead ||
      settings.localManifest.length || settings.historySnapshots.length || settings.historyVersions.length ||
      settings.lastSyncedAt || settings.lastSyncCompletedAt || vault.getFiles().some((file) =>
        !file.path.startsWith(".obsidian/") && file.path !== ".obsidian")) {
    throw new Error("Composite setup requires a new empty vault without sync/recovery evidence; explicit conversion is required");
  }
}
