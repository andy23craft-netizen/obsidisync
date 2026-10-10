import type { ManifestEntry, ServerFileChange, SyncConflict } from "./protocol";
import type { PendingShareSelection } from "./shareSelection";
import { shouldIgnoreVaultPath } from "./ignore";
import { assertSafeVaultPath } from "./security";
import type { ReconciliationVault } from "./vaultState";
import type { MountActionToken } from "./composite";

export interface LocalReconciliation {
  path: string;
  baseline: ManifestEntry | null;
  remote: ServerFileChange;
  remoteHead: string | null;
  reason: string;
  /** Local choices never confer permission to upload. C must explicitly reconcile this barrier. */
  uploadBlocked: true;
  localChoice?: "keep-local";
  backupFolder?: string;
  capturedWrite?: { stage: "staging" | "submitted" | "accepted"; entry: ManifestEntry | null; mountAction?: MountActionToken };
}

export interface ShareDownloadState {
  /** Observation only: never an acknowledgement of local edits. */
  observedHead: string | null;
  lastDownloadedAt?: string;
  baseline: ManifestEntry[];
  reconciliation: LocalReconciliation[];
  /** Saved BEFORE touching a file. An ambiguous interrupted write fails closed on restart. */
  applying?: LocalReconciliation;
  /** Exact captured contents, saved before staging. Never reconstructed by scanning at completion. */
  writing?: { stage: "staging" | "submitted" | "accepted"; entries: Array<{ path: string; entry: ManifestEntry | null }>;
    mountAction?: MountActionToken };
  serverConflicts?: SyncConflict[];
  initial: { backupFolder: string; backupManifest?: ManifestEntry[]; appliedPaths: string[]; complete: boolean };
}

export interface ActiveShare extends Omit<PendingShareSelection, "status" | "syncState" | "observedHead" | "download"> {
  status: "download-only" | "writable";
  download: ShareDownloadState;
}

export function sharePathSupported(path: string): boolean {
  // This client does not advertise inkVaultNotesV1. Do not infer deletion from omitted sources.
  return !shouldIgnoreVaultPath(path) && !path.startsWith(".inkvault/");
}

export function sameFile(a: ManifestEntry | null, b: ManifestEntry | null): boolean {
  return a === null ? b === null : b !== null && a.sha256 === b.sha256;
}

/** Full read snapshots keep blocked targets reachable even after the observed head advances. */
export class ShareReconciler {
  constructor(private readonly vault: ReconciliationVault, private readonly state: ShareDownloadState,
    private readonly save: () => Promise<void>, private readonly assertDestination: () => void,
    private readonly supportedPath: (path: string) => boolean = sharePathSupported,
    private readonly canApply: (path: string) => boolean = () => true) {}

  private block(record: LocalReconciliation): void {
    const previous = this.state.reconciliation.find((entry) => entry.path === record.path);
    this.state.reconciliation = this.state.reconciliation.filter((entry) => entry.path !== record.path);
    this.state.reconciliation.push({ ...record, localChoice: previous?.localChoice,
      capturedWrite: record.capturedWrite ?? previous?.capturedWrite,
      backupFolder: record.backupFolder ?? previous?.backupFolder });
  }

  /** Save downgrade barriers even if the subsequent network read fails. No scan result becomes a baseline. */
  async preserveLocalChanges(): Promise<void> {
    const paths = new Set([...this.vault.paths().filter(this.supportedPath), ...this.state.baseline.map((entry) => entry.path)]);
    for (const path of paths) {
      if (this.state.serverConflicts?.some((entry) => entry.path === path)) continue;
      if (this.state.reconciliation.some((entry) => entry.path === path)) continue;
      this.assertDestination();
      if (!this.canApply(path)) continue;
      const baseline = this.state.baseline.find((entry) => entry.path === path) ?? null;
      let reason = "Local edit retained; future upload requires explicit reconciliation";
      try { if (sameFile(await this.vault.checkedEntryFor(path), baseline)) continue; }
      catch (error) { reason = `Local state uncertain: ${String(error)}`; }
      this.block({ path, baseline, remote: baseline ? { path, op: "upsert", sha256: baseline.sha256 } : { path, op: "delete" },
        remoteHead: this.state.observedHead, reason: `${reason}. Remote target is the last observed version until read sync succeeds`,
        uploadBlocked: true });
      await this.save();
    }
  }

  async applySnapshot(files: ServerFileChange[], head: string | null,
    download: (file: Extract<ServerFileChange, { op: "upsert" }>) => Promise<ArrayBuffer>,
    initial = false): Promise<void> {
    const targets = new Map<string, ServerFileChange>();
    for (const file of files) {
      assertSafeVaultPath(file.path);
      if (file.op !== "delete" && (file.op !== "upsert" || !/^[a-f0-9]{64}$/.test(file.sha256))) {
        throw new Error(`Invalid remote change: ${file.path}`);
      }
      if (this.supportedPath(file.path)) {
        if (targets.has(file.path)) throw new Error(`Duplicate remote path: ${file.path}`);
        targets.set(file.path, file);
      }
    }
    if (this.state.applying) {
      this.block({ ...this.state.applying, reason: "Interrupted application: inspect local bytes before reconciliation" });
      delete this.state.applying;
      await this.save();
    }
    // Snapshot omission means deletion only for known baselines/pending paths (or explicitly backed-up initial files).
    const known = new Set([...this.state.baseline.map((entry) => entry.path),
      ...this.state.reconciliation.map((entry) => entry.path),
      ...(initial ? this.state.initial.backupManifest ?? [] : []).map((entry) => entry.path),
      ...this.vault.paths().filter(this.supportedPath)]);
    for (const path of known) if (!targets.has(path) && this.supportedPath(path)) targets.set(path, { path, op: "delete" });

    for (const remote of targets.values()) {
      this.assertDestination();
      if (!this.canApply(remote.path)) continue;
      // Server conflicts are resolved explicitly, not as local-only preservation decisions.
      if (this.state.serverConflicts?.some((entry) => entry.path === remote.path)) continue;
      const baseline = this.state.baseline.find((entry) => entry.path === remote.path) ?? null;
      const target: ServerFileChange = remote.op === "upsert"
        ? { path: remote.path, op: "upsert", sha256: remote.sha256, size: remote.size } : remote;
      const record: LocalReconciliation = { path: remote.path, baseline, remote: target, remoteHead: head,
        reason: "Unsynchronized local change; explicit reconciliation required", uploadBlocked: true };
      const previous = this.state.reconciliation.find((entry) => entry.path === remote.path);
      if (previous) { this.block({ ...record, baseline: previous.baseline, reason: previous.reason }); await this.save(); continue; }
      // Initial overwrite consent applies ONLY to bytes actually copied into the verified backup.
      const expected = initial && !this.state.initial.appliedPaths.includes(remote.path)
        ? this.state.initial.backupManifest?.find((entry) => entry.path === remote.path) ?? baseline
        : baseline;
      let current: ManifestEntry | null;
      try {
        current = await this.vault.checkedEntryFor(remote.path);
        if (!sameFile(current, expected)) { this.block(record); await this.save(); continue; }
      } catch (error) {
        this.block({ ...record, reason: `Local state uncertain: ${String(error)}` }); await this.save(); continue;
      }
      // Persist the intent before starting disk work. Failed downloads can be retried safely;
      // failed disk application retains the journal because its outcome may be ambiguous.
      let buffer: ArrayBuffer | undefined;
      if (remote.op === "upsert" && current?.sha256 !== remote.sha256) buffer = await this.vault.serverBytes(remote, download);
      this.assertDestination();
      this.state.applying = record;
      await this.save();
      this.assertDestination();
      const applied = await this.vault.applyGuarded(remote, expected, buffer, () => {
        this.assertDestination();
        if (!this.canApply(remote.path)) throw new Error("Mount path is blocked by a detected move");
      });
      this.assertDestination();
      if (!applied) this.block({ ...record, reason: "Local file changed during download/application" });
      else {
        this.state.baseline = this.state.baseline.filter((entry) => entry.path !== remote.path);
        if (remote.op === "upsert") this.state.baseline.push({ path: remote.path, sha256: remote.sha256,
          size: buffer?.byteLength ?? current!.size, mtime: Date.now() });
        if (initial && !this.state.initial.appliedPaths.includes(remote.path)) this.state.initial.appliedPaths.push(remote.path);
      }
      delete this.state.applying;
      await this.save();
    }
    this.state.observedHead = head;
    if (initial) this.state.initial.complete = true;
    await this.save();
  }
}
