import type { Vault } from "obsidian";
import type { ManifestEntry, ServerFileChange } from "./protocol";
import { VaultState } from "./vaultState";
import type { ReconciliationVault, ServerUpsert } from "./vaultState";
import { compositePathSupported, containsPath, pathKey } from "./composite";
import { assertSafeVaultPath } from "./security";

/** Share-relative evidence, vault-relative disk access. Backups always stay at the composite root. */
export class MountedVaultState implements ReconciliationVault {
  private readonly rootState: VaultState;
  constructor(private readonly mountedVault: Vault, readonly prefix: string) {
    this.rootState = new VaultState(mountedVault);
  }

  localPath(path: string): string {
    if (!compositePathSupported(path)) throw new Error("Protected composite path");
    return `${this.prefix}/${path}`;
  }

  paths(): string[] {
    const files = this.mountedVault.getFiles().filter((file) => containsPath(pathKey(this.prefix), pathKey(file.path)));
    const keys = new Set<string>();
    return files.map((file) => {
      if (!file.path.startsWith(`${this.prefix}/`)) throw new Error("Local path aliases mount prefix");
      return file.path.slice(this.prefix.length + 1);
    }).filter(compositePathSupported).map((path) => {
      if (keys.has(pathKey(path))) throw new Error("Local mount paths alias each other");
      keys.add(pathKey(path)); return path;
    });
  }

  /** Conservatively reject Unicode/case aliases on every adapter, including existing folder aliases. */
  async assertUnaliased(path: string): Promise<void> {
    const parts = this.localPath(path).split("/");
    let parent = "";
    for (const part of parts) {
      if (parent && !(await this.mountedVault.adapter.exists(parent))) break;
      const listing = await this.mountedVault.adapter.list(parent);
      const target = parent ? `${parent}/${part}` : part;
      if ([...listing.files, ...listing.folders].some((entry) => pathKey(entry) === pathKey(target) && entry !== target)) {
        throw new Error("Local path aliases remote file or folder");
      }
      parent = target;
    }
  }

  async checkedEntryFor(path: string): Promise<ManifestEntry | null> {
    await this.assertUnaliased(path);
    const entry = await this.rootState.checkedEntryFor(this.localPath(path));
    return entry ? { ...entry, path } : null;
  }

  async capture(path: string): Promise<{ entry: ManifestEntry | null; bytes?: ArrayBuffer }> {
    await this.assertUnaliased(path);
    const result = await this.rootState.capture(this.localPath(path));
    return { ...result, entry: result.entry ? { ...result.entry, path } : null };
  }

  serverBytes(file: ServerUpsert, download: (file: ServerUpsert) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    return this.rootState.serverBytes(file, download);
  }

  async verifiedBackup(folder: string, paths: string[]): Promise<ManifestEntry[]> {
    const entries = await this.rootState.verifiedBackup(folder, paths.map((path) => this.localPath(path)));
    return entries.map((entry) => ({ ...entry, path: entry.path.slice(this.prefix.length + 1) }));
  }

  async computeManifest(): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    for (const path of this.paths()) {
      const entry = await this.checkedEntryFor(path);
      if (!entry) throw new Error("Mount file disappeared during scan");
      entries.push(entry);
    }
    return entries;
  }

  async applyGuarded(file: ServerFileChange, expected: ManifestEntry | null, bytes: ArrayBuffer | undefined,
    assertDestination: () => void): Promise<boolean> {
    assertSafeVaultPath(file.path);
    await this.assertUnaliased(file.path);
    return this.rootState.applyGuarded({ ...file, path: this.localPath(file.path) },
      expected ? { ...expected, path: this.localPath(expected.path) } : null, bytes, assertDestination);
  }
}
