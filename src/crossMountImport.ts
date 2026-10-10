import { Vault } from "obsidian";
import type { IosGitSyncSettings } from "./settings";
import type { ManifestEntry, SyncResponse, SyncConflict } from "./protocol";
import { VaultState } from "./vaultState";
import { assertRegularLocalPath } from "./localLifecycle";
import { assertSafeVaultPath } from "./security";
import { assertMountAction, captureMountAction, compositePathSupported, containsPath, pathKey,
  resolveMount, validateComposite, moveBarrierBlocks } from "./composite";
import type { CompositeMount, MountActionToken } from "./composite";
import { createClientId } from "./runtime";
import type { ShareAction } from "./gitService";

export interface ImportEndpoint {
  localPath: string;
  path: string;
  label: string;
  token?: MountActionToken;
}
export interface ImportFile {
  source: ImportEndpoint;
  currentPath: string;
  currentEndpoint: ImportEndpoint;
  destination: ImportEndpoint;
  captured: ManifestEntry;
  sourceLocal: ManifestEntry | null;
  sourceRemote: string | null;
  destinationLocal: ManifestEntry | null;
  backupFolder?: string;
  backupVerified?: boolean;
  copyIntent?: boolean;
  copied?: boolean;
  submitted?: boolean;
  rejected?: boolean;
  accepted?: boolean;
  deleteApproved?: boolean;
  localDeleteIntent?: boolean;
  localDeleted?: boolean;
  deleteSubmitted?: boolean;
  deleted?: boolean;
}
export interface ImportRecord {
  version: 1;
  id: string;
  moveId?: string;
  replacesId?: string;
  approved: boolean;
  replaceLocal: boolean;
  closed?: boolean;
  files: ImportFile[];
  error?: string;
}
export interface ImportMapping { source: string; destination: string; current?: string }

export interface ImportHost {
  vault: Vault;
  settings: IosGitSyncSettings;
  save(): Promise<void>;
  action(mount: CompositeMount, record?: ImportRecord): ShareAction;
  negotiate(mount: CompositeMount, action: ShareAction): Promise<void>;
  snapshot(mount: CompositeMount, action: ShareAction): Promise<SyncResponse>;
  conflicts(mount: CompositeMount, action: ShareAction): Promise<SyncConflict[]>;
  recover(mount: CompositeMount): Promise<void>;
  submit(mount: CompositeMount, path: string, entry: ManifestEntry | null, bytes: ArrayBuffer | undefined,
    head: string | null, record: ImportRecord, beforeDispatch: () => Promise<void>, conditional: boolean): Promise<void>;
}

const matches = (a: ManifestEntry | null, b: ManifestEntry | null) => a?.sha256 === b?.sha256 && a?.size === b?.size;
const remoteHash = (snapshot: SyncResponse, path: string): string | null => {
  const file = snapshot.files.find((entry) => pathKey(entry.path) === pathKey(path));
  if (file && file.path !== path) throw new Error("Remote destination aliases the selected path");
  return file?.op === "upsert" ? file.sha256 : null;
};

/** Persisted imports are safety barriers, including after a restart or a stale binding. */
export function importPathBlocked(settings: IosGitSyncSettings, mountId: string, path: string, allowedId?: string,
  replacedId?: string): boolean {
  return Boolean(settings.imports?.entries.some((record) => {
    if (!record.approved || record.closed || record.id === allowedId || record.id === replacedId) return false;
    const replacement = settings.imports!.entries.find((entry) => entry.approved && entry.replacesId === record.id);
    const overlaps = (protectedPath: string) => containsPath(pathKey(protectedPath), pathKey(path)) || containsPath(pathKey(path), pathKey(protectedPath));
    return record.files.some((file) =>
      (!file.deleted && file.source.token?.mountId === mountId && overlaps(file.source.path) &&
        !replacement?.files.some((entry) => entry.source.localPath === file.source.localPath)) ||
      (!file.accepted && file.destination.token?.mountId === mountId && overlaps(file.destination.path) &&
        !replacement?.files.some((entry) => entry.destination.localPath === file.destination.localPath)));
  }));
}

export function validateImports(settings: IosGitSyncSettings): void {
  const journal = settings.imports;
  if (journal === undefined) return;
  const invalid = (): never => { throw new Error("Invalid import journal; synchronization stopped; retain recovery settings"); };
  if (!journal || journal.version !== 1 || !Array.isArray(journal.entries)) invalid();
  const ids = new Set<string>();
  for (const record of journal.entries) {
    if (!record || record.version !== 1 || typeof record.id !== "string" || !record.id || ids.has(record.id) ||
        typeof record.approved !== "boolean" || typeof record.replaceLocal !== "boolean" ||
        (record.closed !== undefined && typeof record.closed !== "boolean") ||
        !Array.isArray(record.files) || !record.files.length ||
        (record.moveId !== undefined && typeof record.moveId !== "string") ||
        (record.replacesId !== undefined && (!ids.has(record.replacesId) || record.replacesId === record.id))) invalid();
    ids.add(record.id);
    if (record.replacesId) {
      const previous = journal.entries.find((entry) => entry.id === record.replacesId)!;
      if (journal.entries.filter((entry) => entry.replacesId === previous.id).length !== 1 ||
          previous.files.length !== record.files.length || record.moveId !== previous.moveId ||
          record.files.some((file) => !previous.files.some((old) => old.source?.localPath === file.source?.localPath &&
            old.currentPath === file.currentPath)) || previous.files.some((file) => file.localDeleteIntent)) invalid();
    }
    const endpoints = new Set<string>();
    for (const file of record.files) {
      if (!file || !file.source || !file.destination) invalid();
      for (const endpoint of [file.source, file.destination, file.currentEndpoint]) {
        if (!endpoint) invalid();
        if (typeof endpoint.localPath !== "string" || !compositePathSupported(endpoint.localPath) ||
            typeof endpoint.path !== "string" || !compositePathSupported(endpoint.path) || typeof endpoint.label !== "string") invalid();
        const token = endpoint.token;
        if (token && (typeof token.mountId !== "string" || !token.mountId || typeof token.destination !== "string" ||
            !Number.isSafeInteger(token.revision) || token.revision < 1 ||
            !Number.isSafeInteger(token.moveGeneration) || token.moveGeneration < 0)) invalid();
      }
      if (!file.destination.token || typeof file.currentPath !== "string" || !compositePathSupported(file.currentPath)) invalid();
      for (const entry of [file.captured, file.sourceLocal, file.destinationLocal]) {
        if (entry === null) continue;
        if (!entry || typeof entry.path !== "string" || !compositePathSupported(entry.path) ||
            !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isFinite(entry.size) || entry.size < 0 ||
            !Number.isFinite(entry.mtime)) invalid();
      }
      if (file.currentEndpoint.localPath !== file.currentPath || file.captured.path !== file.currentPath || file.sourceLocal && file.sourceLocal.path !== file.source.localPath ||
          file.destinationLocal && file.destinationLocal.path !== file.destination.localPath ||
          !(file.sourceRemote === null || /^[a-f0-9]{64}$/.test(file.sourceRemote))) invalid();
      for (const flag of [file.backupVerified, file.copyIntent, file.copied, file.submitted, file.rejected, file.accepted,
        file.deleteApproved, file.localDeleteIntent, file.localDeleted, file.deleteSubmitted, file.deleted]) {
        if (flag !== undefined && typeof flag !== "boolean") invalid();
      }
      if (file.backupFolder !== undefined) {
        assertSafeVaultPath(file.backupFolder);
        if (!file.backupFolder.startsWith(".obsidian-git-sync/backups/")) invalid();
      }
      if (file.accepted && (!file.submitted || !file.copied || !file.backupVerified || file.rejected) ||
          file.backupVerified && !file.backupFolder || file.copied && (!file.copyIntent || !file.backupVerified) ||
          file.submitted && !file.copied || file.deleteApproved && !file.accepted ||
          file.localDeleteIntent && (!file.deleteApproved || !file.backupVerified) ||
          file.localDeleted && !file.localDeleteIntent || file.deleteSubmitted && !file.localDeleted ||
          file.deleted && (!file.accepted || !file.localDeleted) ||
          record.approved && file.destinationLocal && file.currentPath !== file.destination.localPath && !record.replaceLocal) invalid();
      for (const endpoint of [file.source.localPath, file.destination.localPath]) {
        if (endpoints.has(pathKey(endpoint))) invalid();
        endpoints.add(pathKey(endpoint));
      }
    }
  }
}

/** Local adapter checks are also used on mobile, where no Node filesystem exists. */
export async function assertImportPath(vault: Vault, path: string): Promise<void> {
  assertSafeVaultPath(path);
  const adapter = vault.adapter;
  await assertRegularLocalPath(vault, path);
  const parts = path.split("/");
  let parent = "";
  for (const part of parts) {
    if (parent && !await adapter.exists(parent)) break;
    const target = parent ? `${parent}/${part}` : part;
    const listing = await adapter.list(parent);
    if ([...listing.files, ...listing.folders].some((entry) => pathKey(entry) === pathKey(target) && entry !== target)) {
      throw new Error("Import path aliases an existing file or folder");
    }
    parent = target;
  }
}

/** Owns consent and local disk intents; the existing share writer owns upload and remote-write recovery. */
export class CrossMountImport {
  private readonly disk: VaultState;
  constructor(private readonly host: ImportHost) { this.disk = new VaultState(host.vault); }

  private endpoint(localPath: string): ImportEndpoint {
    if (!compositePathSupported(localPath)) throw new Error("Protected import path");
    const state = validateComposite(this.host.settings);
    if (state.mounts.some((mount) => pathKey(mount.localPrefix) === pathKey(localPath))) throw new Error("Select files inside the mount");
    const resolved = resolveMount(state, localPath);
    if (!resolved && state.mounts.some((mount) => containsPath(pathKey(mount.localPrefix), pathKey(localPath)))) {
      throw new Error("Protected import path inside a mount");
    }
    return resolved ? { localPath, path: resolved.path,
      label: `${resolved.mount.label} (${resolved.mount.shareId})`, token: captureMountAction(state, resolved.mount) }
      : { localPath, path: localPath, label: "local-only" };
  }

  private mount(endpoint: ImportEndpoint): CompositeMount | undefined {
    if (!endpoint.token) {
      if (resolveMount(validateComposite(this.host.settings), endpoint.localPath)) throw new Error("Local-only endpoint changed; preview again");
      return undefined;
    }
    const mount = assertMountAction(this.host.settings, endpoint.token);
    if (`${mount.localPrefix}/${endpoint.path}` !== endpoint.localPath) throw new Error("Import endpoint binding changed");
    return mount;
  }

  private guard(record: ImportRecord): void {
    validateImports(this.host.settings);
    for (const file of record.files) {
      for (const endpoint of [file.source, file.destination, file.currentEndpoint]) {
        const mount = this.mount(endpoint);
        if (!mount) continue;
        this.host.action(mount, record).guard();
        if (mount.barriers.some((barrier) => moveBarrierBlocks(barrier, endpoint.path) && barrier.moveId !== record.moveId)) {
          throw new Error("New move barrier invalidated import consent; preview again");
        }
        if (importPathBlocked(this.host.settings, mount.mountId, endpoint.path, record.id, record.replacesId)) throw new Error("Another import protects this path");
      }
    }
  }

  private async capture(path: string) {
    await assertImportPath(this.host.vault, path);
    return this.disk.capture(path);
  }

  private async authority(endpoint: ImportEndpoint, record: ImportRecord, write = false) {
    const mount = this.mount(endpoint);
    if (!mount) return undefined;
    const action = this.host.action(mount, record);
    await this.host.negotiate(mount, action); this.guard(record);
    if (!mount.initialized) throw new Error("Finish mount initialization before importing");
    if (write) {
      action.write([endpoint.path]);
      if (record.files.some((file) => file.destination === endpoint) &&
          !this.host.settings.serverFeatures.includes("nativeSyncConditionalCreate")) {
        throw new Error("Server lacks nativeSyncConditionalCreate; import stopped without fallback");
      }
    }
    if (mount.download.applying || mount.download.writing) throw new Error("Recover the existing share journal first");
    if (mount.download.reconciliation.some((entry) => entry.path === endpoint.path)) throw new Error("Reconcile this endpoint before importing");
    const snapshot = await this.host.snapshot(mount, action);
    const conflicts = await this.host.conflicts(mount, action); this.guard(record);
    if (conflicts.some((entry) => entry.path === endpoint.path)) throw new Error("Resolve server conflict before importing");
    return { mount, action, snapshot };
  }

  async preview(mappings: ImportMapping[], moveId?: string, replacesId?: string): Promise<ImportRecord> {
    if (!mappings.length) throw new Error("Explicitly select at least one file");
    const record: ImportRecord = { version: 1, id: createClientId(), moveId, replacesId, approved: false, replaceLocal: false, files: [] };
    const previous = replacesId ? this.host.settings.imports?.entries.find((entry) => entry.id === replacesId) : undefined;
    if (replacesId && (!previous || mappings.length !== previous.files.length ||
        mappings.some((mapping) => !previous.files.some((file) => file.source.localPath === mapping.source &&
          file.currentPath === (mapping.current ?? mapping.source))) || moveId !== previous.moveId)) {
      throw new Error("Recapture must retain the exact original/current source mappings and move attribution");
    }
    if (previous?.files.some((file) => file.localDeleteIntent || file.deleteSubmitted || file.deleted)) {
      throw new Error("Source deletion started; reconcile retained evidence before creating a new import");
    }
    const state = validateComposite(this.host.settings);
    const move = moveId ? state.moves.find((entry) => entry.id === moveId) : undefined;
    if (moveId && !move) throw new Error("Detected move no longer exists");
    for (const mapping of mappings) {
      const source = this.endpoint(mapping.source), destination = this.endpoint(mapping.destination);
      if (!destination.token) throw new Error("Local-only destination: retain the move and reconcile local files; remote-source deletion is unavailable");
      if (source.token?.mountId === destination.token.mountId) throw new Error("Use ordinary same-mount operations");
      const currentPath = mapping.current ?? mapping.source;
      if (move) {
        if (!containsPath(move.from, mapping.source) ||
            `${move.to}${mapping.source.slice(move.from.length)}` !== currentPath) throw new Error("Mapping does not match the detected move");
        // Current bytes may be imported elsewhere; the selected destination must still be an active endpoint.
        if (!previous && currentPath !== destination.localPath) throw new Error("Recover the detected move at its current destination");
      } else if (currentPath !== mapping.source) throw new Error("Current path requires a detected move");
      const captured = await this.capture(currentPath);
      if (!captured.entry || !captured.bytes) throw new Error("Selected source bytes are absent");
      const sourceLocal = (await this.capture(source.localPath)).entry;
      const destinationLocal = (await this.capture(destination.localPath)).entry;
      const file: ImportFile = { source, destination, currentPath, currentEndpoint: this.endpoint(currentPath), captured: captured.entry, sourceLocal,
        destinationLocal, sourceRemote: null };
      record.files.push(file);
      this.guard(record);
      const sourceState = await this.authority(source, record);
      if (sourceState) file.sourceRemote = remoteHash(sourceState.snapshot, source.path);
      const target = await this.authority(destination, record, true);
      if (remoteHash(target!.snapshot, destination.path) !== null) throw new Error("Remote destination collision: reconcile separately or choose a new absent path");
    }
    validateImports({ ...this.host.settings, imports: { version: 1, entries: [...(this.host.settings.imports?.entries ?? []), record] } });
    this.guard(record); return record;
  }

  async approve(preview: ImportRecord, replaceLocal = false): Promise<void> {
    // UI previews are detached values. Persist consent before any adapter or network mutation.
    const record = JSON.parse(JSON.stringify(preview)) as ImportRecord;
    this.guard(record);
    if (this.host.settings.imports?.entries.some((entry) => entry.id === record.id)) throw new Error("Import already approved; resume its journal");
    if (record.replacesId && this.host.settings.imports?.entries.some((entry) => entry.replacesId === record.replacesId)) {
      throw new Error("This plan was already replaced; recapture the latest import");
    }
    for (const file of record.files) {
      if (!matches((await this.capture(file.currentPath)).entry, file.captured) ||
          !matches((await this.capture(file.source.localPath)).entry, file.sourceLocal) ||
          !matches((await this.capture(file.destination.localPath)).entry, file.destinationLocal)) throw new Error("Files changed since preview; preview again");
      if (file.destinationLocal && file.currentPath !== file.destination.localPath && !replaceLocal) {
        throw new Error("Local collision requires separate backup/replacement confirmation");
      }
    }
    this.guard(record);
    const state = validateComposite(this.host.settings);
    record.approved = true; record.replaceLocal = replaceLocal;
    this.host.settings.imports ??= { version: 1, entries: [] };
    this.host.settings.imports.entries.push(record);
    // Older writable clients ignore optional import journals. Make them reject this composite state instead.
    state.version = 2;
    await this.host.save();
    await this.resume(record.id);
  }

  private record(id: string): ImportRecord {
    const record = this.host.settings.imports?.entries.find((entry) => entry.id === id);
    if (!record?.approved) throw new Error("Import approval not found");
    if (record.closed) throw new Error("Import ended with local preservation; use explicit endpoint reconciliation");
    if (this.host.settings.imports?.entries.some((entry) => entry.replacesId === id)) throw new Error("This import was replaced; use the newer journal");
    this.guard(record); return record;
  }

  private async backup(record: ImportRecord, file: ImportFile): Promise<void> {
    if (file.backupVerified) {
      await assertImportPath(this.host.vault, `${file.backupFolder}/${file.currentPath}`);
      const evidence = await this.disk.checkedEntryFor(`${file.backupFolder}/${file.currentPath}`);
      if (!matches(evidence, file.captured)) throw new Error("Recovery copy changed or missing; retain source and reconcile");
      if (file.destinationLocal && file.destination.localPath !== file.currentPath) {
        await assertImportPath(this.host.vault, `${file.backupFolder}/${file.destination.localPath}`);
        const destinationBackup = await this.disk.checkedEntryFor(`${file.backupFolder}/${file.destination.localPath}`);
        if (!matches(destinationBackup, file.destinationLocal)) throw new Error("Destination recovery copy changed or missing; retain source and reconcile");
      }
      return;
    }
    // An interrupted backup gets a new destination. Existing partial evidence is never overwritten or trusted.
    file.backupFolder = `.obsidian-git-sync/backups/import-${createClientId()}`;
    await this.host.save(); this.guard(record);
    const paths = [file.currentPath, ...(file.destinationLocal && file.destination.localPath !== file.currentPath
      ? [file.destination.localPath] : [])];
    for (const path of paths) await assertImportPath(this.host.vault, path);
    const copied = await this.disk.verifiedBackup(file.backupFolder, paths);
    if (!matches(copied.find((entry) => entry.path === file.currentPath) ?? null, file.captured) ||
        file.destinationLocal && !matches(copied.find((entry) => entry.path === file.destination.localPath) ?? null, file.destinationLocal)) {
      throw new Error("Backup differs from preview; no replacement authorized");
    }
    this.guard(record); file.backupVerified = true; await this.host.save();
  }

  private release(record: ImportRecord, endpoint: ImportEndpoint): void {
    const mount = this.mount(endpoint);
    if (!mount || !record.moveId) return;
    for (const barrier of mount.barriers.filter((entry) => entry.moveId === record.moveId && containsPath(entry.path, endpoint.path))) {
      barrier.releasedPaths ??= [];
      if (!barrier.releasedPaths.includes(endpoint.path)) barrier.releasedPaths.push(endpoint.path);
    }
  }

  private async accepted(record: ImportRecord, file: ImportFile): Promise<void> {
    const target = await this.authority(file.destination, record, true);
    if (!file.submitted || file.rejected || remoteHash(target!.snapshot, file.destination.path) !== file.captured.sha256 ||
        !matches((await this.capture(file.destination.localPath)).entry, file.captured)) {
      throw new Error("Destination acceptance is unconfirmed or bytes changed; retain source and recovery copies");
    }
    this.guard(record);
    file.accepted = true;
    this.release(record, file.destination);
    await this.host.save();
  }

  async resume(id: string): Promise<void> {
    const record = this.record(id);
    try {
      for (const file of record.files) {
        if (file.deleted) continue;
        this.guard(record);
        const destination = this.mount(file.destination)!;
        // Recover using the ordinary journal with import paths still blocked from disk application.
        await this.host.recover(destination); this.guard(record);
        if (file.rejected) throw new Error("Destination rejected import; reconcile separately and recapture/reconfirm");
        if (file.submitted) { await this.accepted(record, file); continue; }
        if (!matches((await this.capture(file.source.localPath)).entry, file.sourceLocal)) throw new Error("Source changed; preview again");
        const current = await this.capture(file.currentPath);
        if (!matches(current.entry, file.captured) || !current.bytes) throw new Error("Captured source changed; preview again");
        await this.backup(record, file);
        const target = await this.authority(file.destination, record, true);
        if (remoteHash(target!.snapshot, file.destination.path) !== null) throw new Error("Remote destination collision; no overwrite permitted");
        const local = (await this.capture(file.destination.localPath)).entry;
        const expected = file.copyIntent && matches(local, file.captured) ? local : file.destinationLocal;
        if (!matches(local, expected)) throw new Error("Destination changed; preview again");
        file.copyIntent = true; await this.host.save(); this.guard(record);
        await assertImportPath(this.host.vault, file.destination.localPath);
        if (!await this.disk.applyGuarded({ path: file.destination.localPath, op: "upsert", sha256: file.captured.sha256 },
          expected, current.bytes, () => { this.guard(record); target!.action.write([file.destination.path]); }) ||
          !matches((await this.capture(file.destination.localPath)).entry, file.captured)) throw new Error("Copy verification failed; source retained");
        file.copied = true; await this.host.save(); this.guard(record);
        try {
          await this.host.submit(destination, file.destination.path, { ...file.captured, path: file.destination.path },
            current.bytes, target!.snapshot.serverHead, record, async () => {
              if (!matches((await this.capture(file.destination.localPath)).entry, file.captured) ||
                  !matches((await this.capture(file.currentPath)).entry, file.captured) ||
                  !matches((await this.capture(file.source.localPath)).entry, file.sourceLocal)) throw new Error("Edit invalidated import consent");
              this.guard(record); file.submitted = true; await this.host.save();
            }, true);
        } catch (error) {
          if ([409, 412].includes((error as { status?: number }).status ?? 0)) {
            file.rejected = true; await this.host.save();
          }
          throw error;
        }
        await this.accepted(record, file);
      }
      delete record.error; await this.host.save();
    } catch (error) { record.error = error instanceof Error ? error.message : String(error); await this.host.save(); throw error; }
  }

  /** Separate user action: approval is never inferred from import success or an absent local source. */
  async deleteSources(id: string): Promise<void> {
    const record = this.record(id);
    if (record.files.some((file) => !file.accepted)) throw new Error("Verify every destination before source-deletion consent");
    for (const file of record.files) {
      if (file.deleted) continue;
      await this.accepted(record, file);
      await this.backup(record, file);
      const sourceMount = this.mount(file.source);
      if (sourceMount) { await this.host.recover(sourceMount); this.guard(record); }
      const source = await this.authority(file.source, record, true);
      if (source && file.deleteSubmitted && remoteHash(source.snapshot, file.source.path) === null &&
          (await this.capture(file.source.localPath)).entry === null) {
        await this.accepted(record, file);
        if ((await this.capture(file.source.localPath)).entry) throw new Error("New local source bytes retained; deletion completion stopped");
        this.guard(record); file.deleted = true; this.release(record, file.source); await this.host.save(); continue;
      }
      if (source && remoteHash(source.snapshot, file.source.path) !== file.sourceRemote) {
        throw new Error("Remote source changed; retain copies and reconcile");
      }
      if (file.sourceRemote !== null && file.sourceRemote !== file.captured.sha256) {
        throw new Error("Remote source differs from captured bytes; reconcile before deletion");
      }
      const local = (await this.capture(file.source.localPath)).entry;
      if (!matches(local, file.sourceLocal) && !(file.localDeleteIntent && local === null)) throw new Error("Local source changed; deletion stopped");
      file.deleteApproved = true; file.localDeleteIntent = true;
      await this.host.save(); this.guard(record);
      // Recheck destination after consent persistence, then guard the local compare-and-delete.
      await this.accepted(record, file);
      await assertImportPath(this.host.vault, file.source.localPath);
      if (!await this.disk.applyGuarded({ path: file.source.localPath, op: "delete" }, local, undefined,
        () => { this.guard(record); source?.action.write([file.source.path]); })) throw new Error("Source edit prevented deletion");
      if ((await this.capture(file.source.localPath)).entry) throw new Error("Source deletion could not be verified");
      file.localDeleted = true; await this.host.save();
      if (source && file.sourceRemote !== null) {
        if (file.deleteSubmitted) throw new Error("Source deletion remains unconfirmed; reconcile without replay");
        await this.host.submit(source.mount, file.source.path, null, undefined, source.snapshot.serverHead, record,
          async () => {
            await this.accepted(record, file);
            if ((await this.capture(file.source.localPath)).entry) throw new Error("New source bytes prevent remote deletion");
            this.guard(record); file.deleteSubmitted = true; await this.host.save();
          }, false);
        const confirmed = await this.authority(file.source, record, true);
        if (remoteHash(confirmed!.snapshot, file.source.path) !== null) throw new Error("Source deletion unconfirmed; recovery copy retained");
      }
      if (source && file.sourceRemote === null) {
        const confirmed = await this.authority(file.source, record, true);
        if (remoteHash(confirmed!.snapshot, file.source.path) !== null) throw new Error("New remote source retained; deletion completion stopped");
      }
      await this.accepted(record, file);
      if ((await this.capture(file.source.localPath)).entry) throw new Error("New local source bytes retained; deletion completion stopped");
      this.guard(record); file.deleted = true; this.release(record, file.source); await this.host.save();
    }
  }
}
