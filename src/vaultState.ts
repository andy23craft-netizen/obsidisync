import { normalizePath, TFile, Vault } from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64";
import { shouldIgnoreVaultPath } from "./ignore";
import { diffManifests } from "./manifest";
import { ClientChange, ManifestEntry, ServerFileChange } from "./protocol";
import { assertSafeVaultPath } from "./security";
import { serverFileAlreadyLocal } from "./serverFiles";

export interface CollectedVaultChanges {
  manifest: ManifestEntry[];
  changes: ClientChange[];
}

export interface CollectChangesOptions {
  stageUpload?: (path: string, buffer: ArrayBuffer, entry: ManifestEntry) => Promise<string>;
}

export type ServerUpsert = Extract<ServerFileChange, { op: "upsert" }>;

export interface ApplyServerFilesOptions {
  /** Fetches the bytes of a file the server sent without inline content. */
  download?: (file: ServerUpsert) => Promise<ArrayBuffer>;
  /** sha256 of files already on disk; matching upserts are skipped without touching the file. */
  localHashes?: Map<string, string>;
  onProgress?: (done: number, total: number, path: string) => void;
  /** Called after every file that was written or deleted, so progress can be persisted. */
  onApplied?: (change: { path: string; entry: ManifestEntry | null }) => Promise<void>;
}

export class VaultState {
  constructor(private readonly vault: Vault) {}

  paths(): string[] { return this.vault.getFiles().map((file) => file.path).filter((path) => !shouldIgnoreVaultPath(path)); }

  /** Capture upload bytes and their evidence together; later edits cannot change this acknowledgement. */
  async capture(path: string): Promise<{ entry: ManifestEntry | null; bytes?: ArrayBuffer }> {
    const entry = await this.checkedEntryFor(path);
    if (!entry) return { entry: null };
    const bytes = await this.vault.adapter.readBinary(path);
    if (await sha256Hex(bytes) !== entry.sha256) throw new Error(`File changed while capturing ${path}`);
    return { entry, bytes };
  }

  /** A folder or unreadable file is uncertainty, never evidence of absence. */
  async checkedEntryFor(path: string): Promise<ManifestEntry | null> {
    assertSafeVaultPath(path);
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== "file") throw new Error(`Expected a file at ${path}`);
    const bytes = await this.vault.adapter.readBinary(path);
    const sha256 = await sha256Hex(bytes);
    const after = await this.vault.adapter.stat(path);
    if (!after || after.type !== "file" || after.mtime !== stat.mtime || after.size !== stat.size) {
      throw new Error(`File changed while checking ${path}`);
    }
    return { path, sha256, size: bytes.byteLength, mtime: after.mtime };
  }

  /** Backup hashes describe the bytes copied, not a later scan that could include new edits. */
  async verifiedBackup(folder: string, paths: string[]): Promise<ManifestEntry[]> {
    assertSafeVaultPath(folder);
    if (!folder.startsWith(".obsidian-git-sync/backups/")) throw new Error("Backup must use the sync recovery folder");
    if (await this.vault.adapter.exists(folder, true)) throw new Error("Backup destination already exists");
    await this.ensureParentFolder(`${folder}/placeholder`);
    const copied: ManifestEntry[] = [];
    for (const path of paths) {
      assertSafeVaultPath(path);
      if (shouldIgnoreVaultPath(path)) continue;
      const bytes = await this.vault.adapter.readBinary(path);
      const hash = await sha256Hex(bytes);
      const target = `${folder}/${path}`;
      await this.ensureParentFolder(target);
      await this.vault.adapter.writeBinary(target, bytes);
      if (await sha256Hex(await this.vault.adapter.readBinary(target)) !== hash) throw new Error(`Backup verification failed: ${path}`);
      copied.push({ path, sha256: hash, size: bytes.byteLength, mtime: Date.now() });
    }
    return copied;
  }

  async serverBytes(file: ServerUpsert, download: (file: ServerUpsert) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const bytes = typeof file.contentBase64 === "string" ? base64ToArrayBuffer(file.contentBase64) : await download(file);
    if (await sha256Hex(bytes) !== file.sha256) throw new Error(`Download checksum mismatch: ${file.path}`);
    return bytes;
  }

  /** Final local check follows download, mkdir, and journal persistence. No awaits between check and adapter call. */
  async applyGuarded(file: ServerFileChange, expected: ManifestEntry | null, bytes: ArrayBuffer | undefined,
    assertDestination: () => void): Promise<boolean> {
    assertSafeVaultPath(file.path);
    if (shouldIgnoreVaultPath(file.path)) throw new Error("Cannot apply an ignored path");
    if (file.op === "upsert") await this.ensureParentFolder(file.path);
    let current: ManifestEntry | null;
    try { current = await this.checkedEntryFor(file.path); } catch { return false; }
    if (current?.sha256 !== expected?.sha256) return false;
    assertDestination();
    if (file.op === "delete") {
      if (current) await this.vault.adapter.remove(file.path);
    } else {
      if (current?.sha256 === file.sha256) return true;
      if (!bytes) throw new Error("Missing verified download bytes");
      await this.vault.adapter.writeBinary(file.path, bytes);
    }
    return true;
  }

  async collectChanges(previousManifest: ManifestEntry[], options: CollectChangesOptions = {}): Promise<CollectedVaultChanges> {
    const manifest = await this.computeManifest();
    const diff = diffManifests(manifest, previousManifest.filter((entry) => !shouldIgnoreVaultPath(entry.path)));
    const changes: ClientChange[] = [];

    for (const path of diff.upsertPaths) {
      const buffer = await this.vault.adapter.readBinary(path);
      const entry = manifest.find((manifestEntry) => manifestEntry.path === path);
      if (!entry) continue;
      if (options.stageUpload) {
        const uploadId = await options.stageUpload(path, buffer, entry);
        changes.push({
          path,
          op: "upsert",
          uploadId,
          sha256: entry.sha256,
          mtime: entry.mtime
        });
        continue;
      }
      changes.push({
        path,
        op: "upsert",
        contentBase64: arrayBufferToBase64(buffer),
        sha256: entry.sha256,
        mtime: entry.mtime
      });
    }

    for (const path of diff.deletePaths) {
      changes.push({ path, op: "delete" });
    }

    return { manifest, changes };
  }

  async computeManifest(): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    const files = this.vault
      .getFiles()
      .filter((file) => !shouldIgnoreVaultPath(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const file of files) {
      const buffer = await this.vault.adapter.readBinary(file.path);
      entries.push({
        path: file.path,
        sha256: await sha256Hex(buffer),
        mtime: file.stat.mtime,
        size: file.stat.size
      });
    }

    return entries;
  }

  /** Manifest entry for one file as it is on disk right now, or null when it does not exist. */
  async manifestEntryFor(path: string): Promise<ManifestEntry | null> {
    const safePath = assertSafeVaultPath(path);
    const stat = await this.vault.adapter.stat(normalizePath(safePath));
    if (!stat || stat.type !== "file") return null;
    const buffer = await this.vault.adapter.readBinary(normalizePath(safePath));
    return { path: safePath, sha256: await sha256Hex(buffer), mtime: stat.mtime, size: buffer.byteLength };
  }

  async backupTo(folder: string): Promise<number> {
    const target = normalizePath(folder).replace(/\/+$/, "");
    if (!target) throw new Error("Backup folder must not be empty");

    const manifest = await this.computeManifest();
    for (const entry of manifest) {
      const buffer = await this.vault.adapter.readBinary(entry.path);
      const destination = `${target}/${entry.path}`;
      await this.ensureParentFolder(destination);
      await this.vault.adapter.writeBinary(destination, buffer);
    }
    return manifest.length;
  }

  async deletePaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      const safePath = assertSafeVaultPath(path);
      if (shouldIgnoreVaultPath(safePath)) continue;
      const normalizedPath = normalizePath(safePath);
      if (await this.vault.adapter.exists(normalizedPath, true)) {
        await this.vault.adapter.remove(normalizedPath);
      }
    }
  }

  /**
   * Writes server changes to disk one file at a time. Files arrive either inline (base64) or as
   * references that are downloaded on demand, so memory use stays bounded by the largest file
   * rather than by the vault. Returns the number of files written or deleted.
   */
  async applyServerFiles(files: ServerFileChange[], options: ApplyServerFilesOptions = {}): Promise<number> {
    let applied = 0;
    for (const [index, file] of files.entries()) {
      const safePath = assertSafeVaultPath(file.path);
      if (shouldIgnoreVaultPath(safePath)) continue;
      const normalizedPath = normalizePath(safePath);
      options.onProgress?.(index + 1, files.length, safePath);

      if (file.op === "delete") {
        if (await this.vault.adapter.exists(normalizedPath, true)) {
          await this.vault.adapter.remove(normalizedPath);
        }
        applied += 1;
        await options.onApplied?.({ path: safePath, entry: null });
        continue;
      }

      if (serverFileAlreadyLocal(file, options.localHashes) && (await this.vault.adapter.exists(normalizedPath, true))) {
        continue;
      }

      let buffer: ArrayBuffer;
      if (typeof file.contentBase64 === "string") {
        buffer = base64ToArrayBuffer(file.contentBase64);
      } else if (options.download) {
        buffer = await options.download(file);
      } else {
        throw new Error(`Server sent no content for ${safePath}`);
      }

      await this.ensureParentFolder(normalizedPath);
      await this.vault.adapter.writeBinary(normalizedPath, buffer);
      applied += 1;
      if (options.onApplied) {
        const stat = await this.vault.adapter.stat(normalizedPath);
        await options.onApplied({
          path: safePath,
          entry: { path: safePath, sha256: file.sha256, mtime: stat?.mtime ?? Date.now(), size: buffer.byteLength }
        });
      }
    }
    return applied;
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const index = path.lastIndexOf("/");
    if (index === -1) return;
    const parts = path.slice(0, index).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.vault.adapter.exists(current, true))) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
