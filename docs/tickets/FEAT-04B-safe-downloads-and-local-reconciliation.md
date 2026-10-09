# FEAT-04B: Safe Downloads and Local Reconciliation

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [FEAT-04](FEAT-04-client-share-selection-and-migration.md)

## Problem

Current file application writes/deletes directly, and normal sync replaces its baseline with a whole-vault scan.
Neither is safe for locally edited files receiving remote changes under read-only access.

## Desired Behavior

A selected share supports safe download reconciliation, read/history access and continuing unaffected downloads.
Local edits survive overlapping updates/deletions, uncertainty, restart and capability transitions.

## Current Behavior

VaultState.applyServerFiles in src/vaultState.ts applies bytes/deletions without checking the synchronized baseline
again. GitService.applyServerFiles persists incremental progress and verifies reference downloads.
InitialSyncModal offers force-push or overwrite-local. Server read_sync returns remote changes/head without writes
or server conflicts; read-only synchronization does not update device/version bookkeeping.

## Requirements

- Use A's explicit selected destination and non-mutating sync-state plus POST sync with changes: [].
  Never register, stage uploads, refresh upstream, update metadata or resolve on the server just to download.
- Support authorized history/current/historical files, inline/reference downloads and binary checksum verification.
  Preserve InkVault source feature gating; C owns its mutating resolution workflows.
- Apply remote changes per file only if local state is proven unchanged from the last synchronized baseline.
  Preserve unsynchronized local bytes and local deletions. Uncertain evidence fails closed for that file.
  Continue unaffected downloads instead of pausing the vault.
- Persist visible local reconciliation-required records for overlaps, including remote deletion. Retain enough
  destination/path/baseline and remote version/deletion information for restart and subsequent remote advancement.
  Recheck local state immediately before applying downloaded content/deletion so edits during network work survive.
- Separate remote observation/progress from successfully synchronized per-file baselines. Advancing a head cannot
  acknowledge preserved edits, discard pending remote changes or make blocked changes unreachable.
  Never use a whole-vault scan to mark unsynchronized files synchronized.
- Complete explicit download-side migration/initial reconciliation with backup-before-overwrite behavior.
  Ordinary background downloads cannot perform an implicit overwrite-local decision. Missing initial baseline
  requires explicit reconciliation, not assuming unknown files are unchanged. Preserve A's old state until success.
- Downgrade preserves heads/manifests, pending edits, server/local conflicts and recovery state. Persist blocked
  edits and a reconciliation barrier so restart or write restoration never automatically makes them uploadable.
- While read-only, reconciliation actions are local-only and preserve data; do not expose upload/resolve/force-push
  or mutable metadata actions. Restoration requires explicit reconciliation before blocked edits can upload.
  C must consume this barrier; local choices alone cannot silently authorize future uploads.
- Surface capability and per-file pending status accurately. Unaffected downloads can succeed while conflicts remain.
  Keep local preservation conflicts distinct from server merge conflicts; do not force server semantics onto them.

## Dependencies

[Implemented FEAT-04A](../CLIENT_SHARE_SELECTION.md) supplies destination-bound state/negotiation, a hard dependency.
C depends on this ticket's guarded application, pending records and explicit reconciliation barrier.

## Proposed Implementation

Extend A's persisted state with per-file baseline/pending reconciliation data. Guard VaultState application and
GitService progress accounting; share these primitives with later writable workflows.
Update initial-sync/main/settings/history/conflict UI for read capability and local-only reconciliation.
Reuse existing adapters/checksum/progress machinery without using the server resolver for local preservation.
No server API change is needed. Keep v2 writes unavailable until C supplies capability-aware write execution.

## Testing and Acceptance

- Test discovery/negotiation/read sync/history/file/blob without any write request or server document mutation.
- Test mixed safe/edited files, offline edits, local/remote deletions, overlapping updates, uncertain baselines and
  edits during download. Assert unchanged local bytes for blocked paths and successful unaffected downloads.
- Test interrupted apply/restart, durable local conflicts, later remote advancement and truthful baselines.
- Test downgrade with pending edits/conflicts/recovery, restart and re-upgrade: barriers survive and no automatic
  upload is permitted. Test local-only resolution without server resolve/metadata calls.
- Test explicit initial download migration, backup/failure/cancellation and preservation of old settings.
- Document safe downloads, local conflict recovery and write-restoration requirements with disposable fixtures.

## Manual Verification

A read-only user receives unchanged-file updates while an edited grocery note survives a remote edit/deletion.
Pending reconciliation remains visible after restart. Re-upgrade does not silently upload it. History and downloads
continue, and initial overwrite-local asks for the established explicit reconciliation/backup workflow.

## Non-Goals and Boundaries

No write synchronization/server conflict resolver implementation (C), credentials (D) or composite mounts.
No production access, migration, deployment, sibling repository changes or ARM64 production publication.
