import { Platform, type Vault } from "obsidian";
import type { IosGitSyncSettings } from "./settings";
import type { CompositeState } from "./composite";
import { assertMountPrefixes, compositePathSupported, mountDestination, pathKey, resolveMount, validateComposite } from "./composite";
import { assertSafeVaultPath } from "./security";
import { sha256Hex, VaultState } from "./vaultState";
import { createClientId } from "./runtime";
import { MountedVaultState } from "./mountedVaultState";

/** Reject filesystem links before conversion/import disk effects; mobile uses its vault adapter. */
export async function assertRegularLocalPath(vault: Vault, path: string): Promise<void> {
  assertSafeVaultPath(path);
  const adapter = vault.adapter as typeof vault.adapter & { getBasePath?: () => string };
  if (Platform.isDesktopApp && typeof adapter.getBasePath === "function") {
    const fs = require("fs") as typeof import("fs");
    const nodePath = require("path") as typeof import("path");
    let current = adapter.getBasePath();
    for (const part of path.split("/")) {
      current = nodePath.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink conversion/import is unsupported"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
    }
  }
}

export interface ConversionMapping { source: string; destination: string; sha256: string; size: number; destinationAbsent: true;
  intent?: "copy" | "remove-source" | "restore-source" | "remove-destination"; verified?: boolean }
export interface ConversionJournal {
  version: 1; id: string; phase: "planned" | "relocating" | "ready-to-activate" | "activated" | "reversed";
  original: IosGitSyncSettings; originalHash: string; originalRevision: number;
  proposed: CompositeState; mappings: ConversionMapping[]; exclusions: Array<{ path: string; sha256: string }>;
  backupFolder: string; settingsBackup: string; settingsHash: string; activationRevision?: number;
  recoveryRequired?: boolean;
}
export interface BindingArchive {
  id: string; at: string; unresolved: true; reason: "explicit-detachment";
  mountId?: string; original: IosGitSyncSettings;
}

export const cloneSettings = (settings: IosGitSyncSettings): IosGitSyncSettings => JSON.parse(JSON.stringify(settings));
export function replaceSettings(settings: IosGitSyncSettings, next: IosGitSyncSettings): void {
  for (const key of Object.keys(settings)) delete (settings as any)[key];
  Object.assign(settings, cloneSettings(next));
}

/** Validate transitions before defaults, routing, startup or requests can select an engine. */
export function validateLifecycle(settings: IosGitSyncSettings): void {
  const fail = (): never => { throw new Error("Invalid local lifecycle state; engines stopped, no legacy fallback"); };
  if (settings.settingsRevision !== undefined && (!Number.isSafeInteger(settings.settingsRevision) || settings.settingsRevision < 0)) fail();
  const archives = settings.bindingArchives;
  if (archives !== undefined && (!archives || archives.version !== 1 || !Array.isArray(archives.entries) ||
      archives.entries.some((entry) => !entry || typeof entry.id !== "string" || !entry.id || entry.unresolved !== true ||
        entry.reason !== "explicit-detachment" || !entry.original || typeof entry.original.serverUrl !== "string") ||
      new Set(archives.entries.map((entry) => entry.id)).size !== archives.entries.length)) fail();
  if (settings.disabledBinding !== undefined && (!settings.disabledBinding || !archives?.entries.some((entry) => entry.id === settings.disabledBinding?.archiveId) ||
      settings.activeShare || settings.pendingShareSelection)) fail();
  const journal = settings.conversion;
  if (journal === undefined) {
    if (settings.conversionGate !== undefined || settings.conversionActivation !== undefined) fail();
    return;
  }
  if (!journal || journal.version !== 1 || !journal.id || !["planned", "relocating", "ready-to-activate", "activated", "reversed"].includes(journal.phase) ||
      !journal.original || !/^[a-f0-9]{64}$/.test(journal.originalHash) || !/^[a-f0-9]{64}$/.test(journal.settingsHash) ||
      journal.settingsHash !== journal.originalHash ||
      !Number.isSafeInteger(journal.originalRevision) || !Array.isArray(journal.mappings) || !Array.isArray(journal.exclusions) ||
      !journal.backupFolder?.startsWith(".obsidian-git-sync/backups/") || journal.settingsBackup !== `${journal.backupFolder}/settings.json`) fail();
  assertSafeVaultPath(journal.backupFolder);
  const candidate = cloneSettings(settings);
  delete candidate.activeShare; delete candidate.pendingShareSelection;
  candidate.composite = journal.proposed;
  validateComposite(candidate);
  const sources = new Set<string>(), destinations = new Set<string>();
  for (const mapping of journal.mappings) {
    if (!mapping || !compositePathSupported(mapping.source) || !compositePathSupported(mapping.destination) ||
        mapping.destinationAbsent !== true || !/^[a-f0-9]{64}$/.test(mapping.sha256) || !Number.isFinite(mapping.size) || mapping.size < 0 ||
        (mapping.intent !== undefined && !["copy", "remove-source", "restore-source", "remove-destination"].includes(mapping.intent))) fail();
    if (!resolveMount(journal.proposed, mapping.destination) || sources.has(pathKey(mapping.source)) ||
        destinations.has(pathKey(mapping.destination))) fail();
    sources.add(pathKey(mapping.source)); destinations.add(pathKey(mapping.destination));
  }
  if ([...sources].some((path) => destinations.has(path))) fail();
  for (const mount of journal.proposed.mounts) {
    const prior = journal.original.composite?.mounts.find((entry) => entry.mountId === mount.mountId);
    if (prior ? JSON.stringify(prior) !== JSON.stringify(mount) :
      (mount.initialized || mount.status !== "download-only" || mount.moveGeneration !== 0 || mount.barriers.length ||
        mount.download.observedHead !== null || mount.download.baseline.length || mount.download.reconciliation.length ||
        mount.download.writing || mount.download.applying || mount.download.serverConflicts?.length || mount.download.initial.complete ||
        mount.download.initial.backupFolder || mount.download.initial.backupManifest || mount.download.initial.appliedPaths.length)) fail();
  }
  for (const exclusion of journal.exclusions) {
    assertSafeVaultPath(exclusion.path);
    if (!/^[a-f0-9]{64}$/.test(exclusion.sha256)) fail();
  }
  const preActivation = ["planned", "relocating", "ready-to-activate"].includes(journal.phase);
  if (preActivation ? settings.conversionGate !== journal.id : settings.conversionGate !== undefined) fail();
  if (journal.phase !== "activated" && settings.conversionActivation !== undefined) fail();
  if (journal.phase === "activated" && (!settings.composite || settings.activeShare || settings.pendingShareSelection ||
      settings.conversionActivation?.id !== journal.id || settings.conversionActivation.revision !== journal.activationRevision ||
      !Number.isSafeInteger(journal.activationRevision) || journal.activationRevision! > settings.composite.revision)) fail();
  if (journal.phase === "activated") for (const mount of journal.proposed.mounts) {
    const current = settings.composite!.mounts.find((entry) => entry.mountId === mount.mountId);
    if (current && mountDestination(current) !== mountDestination(mount)) fail();
  }
}

export function lifecycleBlocker(settings: IosGitSyncSettings): string | null {
  validateLifecycle(settings);
  if (settings.conversionGate !== undefined) return "Local conversion requires recovery or reversal; synchronization is disabled.";
  if (settings.disabledBinding && settings.composite === undefined) return "Original binding detached; configure and reconcile a new destination explicitly.";
  return null;
}

/** Local-only copy/verify/remove journal. The caller drains requests and serializes settings snapshots. */
export class LocalLifecycle {
  private uncertain = false;
  constructor(private readonly vault: Vault, private readonly settings: IosGitSyncSettings,
    private readonly persist: (snapshot: IosGitSyncSettings) => Promise<void>) {}

  private async save(candidate: IosGitSyncSettings): Promise<void> {
    if (this.uncertain) throw new Error("Lifecycle save outcome uncertain; reload persisted settings before recovery");
    candidate.settingsRevision = (this.settings.settingsRevision ?? 0) + 1;
    validateLifecycle(candidate);
    try { await this.persist(cloneSettings(candidate)); }
    catch (error) { this.uncertain = true; throw error; }
    replaceSettings(this.settings, candidate);
  }

  private async regular(path: string): Promise<void> {
    await assertRegularLocalPath(this.vault, path);
  }

  private async bytes(path: string): Promise<ArrayBuffer | null> {
    await this.regular(path);
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== "file") throw new Error("Conversion path is not a regular file");
    return this.vault.adapter.readBinary(path);
  }
  private async hash(path: string): Promise<string | null> {
    const bytes = await this.bytes(path); return bytes ? sha256Hex(bytes) : null;
  }
  private async parent(path: string): Promise<void> {
    let folder = "";
    for (const part of path.split("/").slice(0, -1)) {
      folder = folder ? `${folder}/${part}` : part;
      await this.regular(folder);
      if (!await this.vault.adapter.exists(folder)) await this.vault.adapter.mkdir(folder);
    }
  }

  async preview(proposed: CompositeState, mappings: Array<{ source: string; destination: string }>): Promise<ConversionMapping[]> {
    validateLifecycle(this.settings);
    assertMountPrefixes(proposed.mounts);
    const candidate = cloneSettings(this.settings);
    delete candidate.activeShare; delete candidate.pendingShareSelection; candidate.composite = proposed;
    validateComposite(candidate);
    const sources = new Set<string>(), destinations = new Set<string>();
    const existing = this.vault.getFiles().map((file) => file.path);
    const result: ConversionMapping[] = [];
    for (const mapping of mappings) {
      if (!compositePathSupported(mapping.source) || !compositePathSupported(mapping.destination) ||
          !resolveMount(proposed, mapping.destination) || sources.has(pathKey(mapping.source)) || destinations.has(pathKey(mapping.destination)) ||
          (this.settings.composite && resolveMount(this.settings.composite, mapping.source))) {
        throw new Error("Unsupported, duplicated or active-mount conversion mapping; detach active sources first");
      }
      if (existing.some((path) => pathKey(path) === pathKey(mapping.destination)) || await this.vault.adapter.exists(mapping.destination)) {
        throw new Error("Conversion destination collision; existing bytes will not be overwritten");
      }
      if (existing.some((path) => path !== mapping.source && pathKey(path) === pathKey(mapping.source))) {
        throw new Error("Conversion source has a case or Unicode alias");
      }
      // Reject folder spelling aliases using the same adapter checks as scoped synchronization.
      const resolved = resolveMount(proposed, mapping.destination)!;
      await new MountedVaultState(this.vault, resolved.mount.localPrefix).assertUnaliased(resolved.path);
      const bytes = await this.bytes(mapping.source);
      if (!bytes) throw new Error("Conversion source is missing");
      sources.add(pathKey(mapping.source)); destinations.add(pathKey(mapping.destination));
      result.push({ source: mapping.source, destination: mapping.destination, sha256: await sha256Hex(bytes), size: bytes.byteLength, destinationAbsent: true });
    }
    if ([...sources].some((path) => destinations.has(path))) throw new Error("Conversion mappings cannot overwrite another source");
    return result;
  }

  async plan(proposed: CompositeState, mappings: ConversionMapping[]): Promise<void> {
    if (this.settings.conversionGate) throw new Error("Recover existing conversion first");
    const original = cloneSettings(this.settings);
    const originalText = JSON.stringify(original);
    const originalHash = await sha256Hex(new TextEncoder().encode(originalText).buffer);
    const captured = await this.preview(proposed, mappings);
    if (JSON.stringify(captured) !== JSON.stringify(mappings.map(({ source, destination, sha256, size, destinationAbsent }) => ({ source, destination, sha256, size, destinationAbsent })))) {
      throw new Error("Source changed since preview; preview again");
    }
    const id = createClientId(), folder = `.obsidian-git-sync/backups/conversion-${id}`;
    await this.regular(`${folder}/files`);
    for (const mapping of captured) await this.regular(mapping.source);
    const backup = await new VaultState(this.vault).verifiedBackup(`${folder}/files`, captured.map((mapping) => mapping.source));
    for (const mapping of captured) if (backup.find((file) => file.path === mapping.source)?.sha256 !== mapping.sha256) throw new Error("Backup does not match preview");
    const settingsBackup = `${folder}/settings.json`;
    await this.parent(settingsBackup);
    await this.vault.adapter.writeBinary(settingsBackup, new TextEncoder().encode(originalText).buffer);
    if (await this.hash(settingsBackup) !== originalHash) throw new Error("Settings backup verification failed");
    if (JSON.stringify(this.settings) !== originalText) throw new Error("Settings changed during conversion backup; preview again");
    const exclusions: ConversionJournal["exclusions"] = [];
    for (const file of this.vault.getFiles()) {
      if (!compositePathSupported(file.path) || file.path.startsWith(".obsidian/") || captured.some((mapping) => mapping.source === file.path)) continue;
      const hash = await this.hash(file.path); if (hash) exclusions.push({ path: file.path, sha256: hash });
    }
    for (const mapping of captured) if (await this.hash(mapping.source) !== mapping.sha256 || await this.hash(mapping.destination) !== null) {
      throw new Error("Files changed before conversion planning");
    }
    const candidate = cloneSettings(this.settings);
    candidate.conversion = { version: 1, id, phase: "planned", original, originalHash, originalRevision: original.settingsRevision ?? 0,
      proposed, mappings: captured, exclusions, backupFolder: folder, settingsBackup, settingsHash: originalHash, recoveryRequired: true };
    candidate.conversionGate = id; delete candidate.conversionActivation;
    await this.save(candidate);
  }

  private async evidence(): Promise<ConversionJournal> {
    validateLifecycle(this.settings);
    const journal = this.settings.conversion;
    if (!journal || !this.settings.conversionGate) throw new Error("No pre-activation conversion to recover");
    const configuration = (value: IosGitSyncSettings) => {
      const copy = cloneSettings(value);
      delete copy.conversion; delete copy.conversionGate; delete copy.conversionActivation; delete copy.settingsRevision;
      return JSON.stringify(copy);
    };
    if (configuration(this.settings) !== configuration(journal.original)) throw new Error("Original configuration changed while gated; reload matching settings before recovery");
    if (await sha256Hex(new TextEncoder().encode(JSON.stringify(journal.original)).buffer) !== journal.originalHash ||
        await this.hash(journal.settingsBackup) !== journal.settingsHash) throw new Error("Original settings evidence mismatch");
    for (const mapping of journal.mappings) if (await this.hash(`${journal.backupFolder}/files/${mapping.source}`) !== mapping.sha256) {
      throw new Error("Original file backup mismatch");
    }
    return journal;
  }

  private async phase(phase: ConversionJournal["phase"]): Promise<void> {
    const candidate = cloneSettings(this.settings); candidate.conversion!.phase = phase; await this.save(candidate);
  }
  private async intent(index: number, intent: ConversionMapping["intent"]): Promise<void> {
    const candidate = cloneSettings(this.settings); candidate.conversion!.mappings[index].intent = intent; await this.save(candidate);
  }

  async resume(): Promise<void> {
    const journal = await this.evidence();
    await this.phase("relocating");
    for (const [index, mapping] of journal.mappings.entries()) {
      let source = await this.hash(mapping.source), destination = await this.hash(mapping.destination);
      if ((source !== null && source !== mapping.sha256) || (destination !== null && destination !== mapping.sha256) ||
          (source === null && destination === null)) throw new Error("Conversion bytes uncertain; copies retained for recovery");
      if (destination === null) {
        await this.intent(index, "copy");
        const resolved = resolveMount(journal.proposed, mapping.destination)!;
        await new MountedVaultState(this.vault, resolved.mount.localPrefix).assertUnaliased(resolved.path);
        await this.parent(mapping.destination);
        const bytes = await this.bytes(mapping.source);
        if (!bytes || await sha256Hex(bytes) !== mapping.sha256 || await this.hash(mapping.destination) !== null) throw new Error("Copy precondition changed");
        await this.vault.adapter.writeBinary(mapping.destination, bytes);
        if (await this.hash(mapping.destination) !== mapping.sha256) throw new Error("Copied bytes failed verification");
      }
      source = await this.hash(mapping.source);
      if (source !== null) {
        await this.intent(index, "remove-source");
        if (await this.hash(mapping.destination) !== mapping.sha256 || await this.hash(mapping.source) !== mapping.sha256) throw new Error("Removal precondition changed");
        await this.vault.adapter.remove(mapping.source);
      }
      if (await this.hash(mapping.source) !== null || await this.hash(mapping.destination) !== mapping.sha256) throw new Error("Relocation outcome uncertain");
      const candidate = cloneSettings(this.settings); candidate.conversion!.mappings[index].verified = true;
      delete candidate.conversion!.mappings[index].intent; await this.save(candidate);
    }
    for (const exclusion of journal.exclusions) if (await this.hash(exclusion.path) !== exclusion.sha256) throw new Error("Excluded file changed; inspect before activation");
    // Recheck every mapping even when persisted progress claims completion.
    for (const mapping of journal.mappings) if (await this.hash(mapping.source) !== null || await this.hash(mapping.destination) !== mapping.sha256) throw new Error("Final relocation verification failed");
    await this.phase("ready-to-activate");
  }

  async activate(): Promise<void> {
    await this.resume();
    const journal = await this.evidence();
    const candidate = cloneSettings(this.settings);
    candidate.composite = cloneSettings({ composite: journal.proposed } as IosGitSyncSettings).composite;
    delete candidate.activeShare; delete candidate.pendingShareSelection; delete candidate.disabledBinding;
    candidate.conversion!.phase = "activated";
    candidate.conversion!.recoveryRequired = false;
    candidate.conversion!.activationRevision = journal.proposed.revision;
    candidate.conversionActivation = { id: journal.id, revision: journal.proposed.revision };
    delete candidate.conversionGate;
    await this.save(candidate); // Publish only after the entire activation snapshot is durably saved.
  }

  async reverse(): Promise<void> {
    const journal = await this.evidence();
    for (const [index, mapping] of journal.mappings.entries()) {
      const source = await this.hash(mapping.source), destination = await this.hash(mapping.destination);
      if (source !== null && source !== mapping.sha256) throw new Error("Changed source retained; reversal requires manual reconciliation");
      if (destination !== null && destination !== mapping.sha256) throw new Error("Changed destination retained; reversal requires manual reconciliation");
      if (source === null) {
        await this.intent(index, "restore-source"); await this.parent(mapping.source);
        const bytes = await this.bytes(`${journal.backupFolder}/files/${mapping.source}`);
        if (!bytes || await this.hash(mapping.source) !== null || await sha256Hex(bytes) !== mapping.sha256) throw new Error("Restore precondition changed");
        await this.vault.adapter.writeBinary(mapping.source, bytes);
      }
      if (await this.hash(mapping.source) !== mapping.sha256) throw new Error("Restored source verification failed");
      if (destination !== null) {
        await this.intent(index, "remove-destination");
        if (await this.hash(mapping.source) !== mapping.sha256 || await this.hash(mapping.destination) !== mapping.sha256) throw new Error("Reversal removal precondition changed");
        await this.vault.adapter.remove(mapping.destination);
      }
    }
    for (const mapping of journal.mappings) if (await this.hash(mapping.source) !== mapping.sha256 || await this.hash(mapping.destination) !== null) throw new Error("Final reversal verification failed");
    const candidate = cloneSettings(journal.original);
    candidate.conversion = { ...cloneSettings(this.settings).conversion!, phase: "reversed", recoveryRequired: false };
    delete candidate.conversionGate; delete candidate.conversionActivation;
    await this.save(candidate);
  }

  async detach(mountId?: string): Promise<void> {
    validateLifecycle(this.settings);
    if (this.settings.conversionGate) throw new Error("Reverse or finish the conversion before detachment");
    const original = cloneSettings(this.settings), candidate = cloneSettings(this.settings);
    if (candidate.composite && !candidate.composite.mounts.some((mount) => mount.mountId === mountId)) throw new Error("Name the mount to detach");
    if (!candidate.composite && candidate.disabledBinding) throw new Error("Binding already detached");
    const archive: BindingArchive = { id: createClientId(), at: new Date().toISOString(), unresolved: true,
      reason: "explicit-detachment", mountId, original };
    candidate.bindingArchives ??= { version: 1, entries: [] };
    candidate.bindingArchives.entries.push(archive);
    if (candidate.composite) {
      candidate.composite.mounts = candidate.composite.mounts.filter((mount) => mount.mountId !== mountId);
      candidate.composite.revision++;
      for (const move of candidate.composite.moves) move.mountIds = move.mountIds.filter((id) => id !== mountId);
      candidate.composite.moves = candidate.composite.moves.filter((move) => move.mountIds.length);
    } else {
      delete candidate.activeShare; delete candidate.pendingShareSelection;
      candidate.disabledBinding = { archiveId: archive.id };
    }
    await this.save(candidate);
  }
}
