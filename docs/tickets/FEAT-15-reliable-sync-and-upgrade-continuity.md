# FEAT-15 - Automatic device sync, composite recovery and upgrade continuity

**Status:** Proposed  
**Owner:** ObsidiSync client, with server integration validation  
**Priority:** High - ordinary household sync is requiring manual recovery

## Goal

Changes made on either computer or phone should reach the other device automatically during normal synchronization.
Only concurrent edits or a concrete safety/recovery condition should need a decision. Fix the reported composite-state
failure, provide a bulk remote recovery choice, and preserve completed setup across compatible plugin updates.

## Context

User report, 2026-10-19:

- After the recent "Back up and upload all" fix, files created on the computer require individual download approval
  on the phone. There is no corresponding bulk download choice.
- After manually approving all downloads the previous evening, reopening the phone produced
  "Invalid composite state; synchronization stopped, no v1 fallback" without further Obsidian changes.
- Repeating the lengthy setup after patches makes updates impractical.

Repository findings (not a reproduction of the phone failure):

- `src/shareReconciliation.ts`, `ShareReconciler.applySnapshot`, already intends to apply remote files automatically
  when local contents match the per-file baseline, including an absent local path with no baseline. Existing
  reconciliation records instead remain blocked, even when a later snapshot advances the remote target.
- `src/gitService.ts`, `performShareSync`, handles writable uploads, exact captured acknowledgements and subsequent
  guarded snapshots. Download-only paths preserve local changes. `isAutomaticLocalAddition` releases only narrowly
  identified local additions; it is not a general remote-download recovery mechanism.
- `src/localReconciliationModal.ts` exposes bulk upload but only individual "Back up and use remote" actions.
  `useRemoteChoice` refreshes the target, verifies a backup, journals application and advances only the applied baseline.
- `src/composite.ts`, `validateComposite`, emits the reported generic error for many schema, binding, manifest,
  initialization, journal and move invariants. Composite versions 1 and 2 are recognized. The exact failed invariant
  and persisted phone state are unknown; do not claim a confirmed corruption or upgrade cause.
- `src/main.ts`, `loadSettings`, validates loaded lifecycle/import/composite state before normal initialization.
  Saves serialize captured settings snapshots. Plugin version changes are not themselves an explicit setup-reset
  condition in this loader. Investigate installation/reload and state compatibility before prescribing a reset fix.
- Current share/composite runbooks already promise automatic ordinary synchronization, isolated mount state,
  durable recovery barriers and no v1 fallback. Server share routing/authentication and independent WebDAV grants
  remain the access boundaries; this ticket does not replace them.

## Scope

### Ordinary synchronization

Trace computer upload through server acceptance, phone snapshot application, baseline persistence and phone restart.
Reproduce new text and attachment creation in both directions, then edits and deletions. Identify why safe remote
changes acquire or retain reconciliation records instead of treating every record as a true concurrent edit.

For initialized mounts, automatically download remote additions into absent local paths and remote updates/deletions
where local contents still match the synchronized baseline. Upload ordinary local-only changes automatically when
writes are enabled and authorized. Download-only/read-only mounts still receive safe remote changes automatically.
Identical contents should converge without a redundant decision when there is sufficient trustworthy state.

Use existing startup, timer, manual and resume behavior as applicable: process safe changes on the next successful
sync without approval. "Immediately" means no human gate once a change is observed by an active client, not a promise
of execution while iOS suspends Obsidian. Do not introduce push infrastructure for this ticket.

Concurrent changes must use existing merge/conflict semantics without silent loss. Initial replacement consent,
explicit Keep local choices, permission-loss preservation, move barriers, unreadable paths and ambiguous writes
remain legitimate gates. If old false-positive records can be proven safe, release only those records from durable
evidence; uncertainty requires an explained recovery choice. Never clear all barriers on startup or update.

### Bulk remote recovery

Add "Back up and download all" alongside bulk upload for the current selected share/mount. One confirmation explains
the count and that current remote versions, including deletions, replace the listed local choices after backup.
Offer this to authorized readers too; downloading does not require upload authority.

Capture the confirmed record set and destination, refresh authorized remote targets, and make a fresh checksum-verified
backup of every local file being replaced before the first replacement. Record absent local paths as absence evidence.
Backup failure permits no replacement. Do not expand consent to records arriving after confirmation or sibling mounts.
Keep server conflicts and move endpoints in their existing separate workflows and explain skipped items.

Reuse guarded per-file application, pinned/checksummed downloads and durable intent saves. Recheck local contents,
binding and authority before applying. An edit during the operation remains preserved and blocked. Report applied,
skipped and failed counts plus the backup location; retain recoverable partial progress after interruption. A retry
does not silently overwrite newer local edits or replay stale consent. This action never uploads or resolves server
conflicts and does not automatically enable writes.

### Composite validation and recovery

Reproduce save/load after individual and bulk reconciliation, startup/resume and representative previous-release
state. Audit all state producers against `validateComposite`, including initial backup evidence, captured mount
actions, move generations and cross-mount import versions. Fix the actual invalid transition or compatibility gap
with a regression fixture. Do not relax ownership or path checks merely to make the error disappear.

Introduce stable validation reason codes and a safe settings/recovery view that remains reachable when normal sync
cannot initialize. Explain the failing invariant and next action without exposing notes, filenames, identities,
tokens or raw settings in shareable diagnostics. Preserve the original state before any repair/migration.

Known, unambiguous older schemas may migrate locally with validation and durable recovery evidence. Unknown schemas,
malformed ownership and ambiguous journals stay stopped with actionable recovery instructions. Never use v1 fallback,
silently recreate mounts, delete plugin data or infer synchronization success from a remote head alone.

### Upgrade continuity and setup friction

Define and test the supported in-place update path using existing BRAT/manual installation workflows. Compatible
patches must retain server/account binding, session refresh state, mount IDs/prefixes, initialization, writable
choices, heads/baselines, backups, conflicts and in-flight recovery evidence. No repeat share selection, conversion,
full replacement or enable-writes confirmation solely because a plugin/server patch was installed.

Separate first installation, compatible update, expired login and genuinely incompatible state in the UI and runbook.
Reauthentication should preserve sync configuration and evidence when the verified identity is unchanged. A changed
identity or destination must retain existing binding protections. If setup is genuinely incomplete, resume the saved
step rather than restarting completed backups/downloads. Show readiness and the specific remaining action per mount.

Document a short normal update procedure and explicit exceptional recovery steps. Server deployment stays with Marvin;
do not automate host changes or hide required server/data migrations inside a client update.

## Proposed contracts and persistence

- Preserve existing v2 sync/blob/conflict APIs and per-mount ownership. No server protocol change is currently needed.
- Validation failure exposes a stable reason code, safe component/field category, and recovery action. Keep sensitive
  values out of notices/exported diagnostics; detailed raw state is protected local recovery material.
- Batch remote consent is bound to one destination and the captured record set. Each applied file independently
  advances its baseline only after guarded disk application and persistence; observed head advancement is insufficient.
- Any persisted schema change has an explicit supported-version migration, backup and failure behavior. A failed or
  uncertain migration retains original evidence and blocks synchronization. Newer unknown state cannot become defaults.
- Serialize recovery and sync mutations using existing service/persistence boundaries. Preserve application/write
  journal ordering across reload and overlapping settings saves.

## Acceptance criteria

1. A computer-created Markdown file reaches an initialized phone mount on its next successful sync without approval;
   the reverse direction works in writable mode, including after restart.
2. Binary additions, ordinary edits and deletions follow the same baseline-based rules without repeated approval.
3. Safe remote changes download automatically in download-only/read-only mode; no upload is attempted there.
4. Concurrent edit/edit, edit/delete and same-path independent creation retain conflicting contents through existing
   merge/recovery behavior. Unaffected files and mounts continue when safe.
5. Successful application/reconciliation survives serialized save/load and a later unchanged launch without producing
   the reported composite error or re-requesting the same decision.
6. The reported invalid-state class has a reproducing regression fixture or a clearly documented diagnostic limitation;
   each remaining validator failure identifies an actionable safe reason. Do not label the incident fixed without
   evidence connecting the corrected transition to the failure.
7. Bulk download processes the confirmed eligible record set after one confirmation and verified backup, including
   remote deletions; per-file choices remain available.
8. Failed backup changes no target files. Concurrent local edits, stale bindings, denied reads, checksum failures and
   interruption preserve bytes/evidence and produce truthful partial results without clearing unrelated barriers.
9. A compatible in-place patch update retains setup and recovery state and resumes normal sync without onboarding.
10. Expired-session renewal or same-identity login preserves mount setup; identity changes never reuse another binding's
    baseline. Unsupported/malformed state stops safely with reachable recovery guidance and no v1 requests.
11. Permission restoration, upgrades and bulk recovery do not authorize retained uploads, cross-share moves or sibling
    changes. Inaccessible shares remain non-enumerable and cannot supply content/history/blobs through recovery actions.
12. Updated runbooks distinguish normal updates from first setup and exceptional recovery, including backup/settings
    retention and rollback limitations after newer writes.

## Testing and validation

- Extend `tests/shareDownloads.test.ts` and `tests/compositeDownloads.test.ts` for both directions, remote additions,
  binary references, deletion/concurrency, barrier classification, batch backup failure, edits during transfer,
  interrupted application and exact-baseline persistence. Include UI batch confirmation/count/disabled-state coverage.
- Add save/load fixtures for supported composite schemas and reconciliation/write/move/import states. Exercise actual
  loader behavior, migration failure, repeated migration, unknown versions and persistence errors; assertions must
  cover retained evidence and absence of fallback/mutation, not merely successful validation.
- Extend the real-server e2e harness with two independently persisted device clients sharing a synthetic share.
  Exercise computer-to-phone and reverse sync, independent restart, permission loss and inaccessible share requests.
  Preserve existing authorization/WebDAV regressions; extend them only if server contracts change.
- Use existing WSL commands: `npm run test:plugin`, `npm run build:plugin`, and `npm run test:e2e`.
  Run `npm run test:server` for relevant server regression validation, mandatorily if server behavior changes.
- Perform desktop/iPhone acceptance with disposable notes: install an update over configured state, refresh an expired
  session, create/edit/delete text and attachments on each device, bulk-download genuine retained records, close and
  reopen unchanged. Record versions, outcomes and platform limits without collecting private content.

## Rollout and recovery

Client-focused change; no share-storage migration or credential retargeting is proposed. Keep protected copies of
plugin settings and affected local files before state migration. Preserve server history/binary stores unchanged.
If a schema change prevents downgrade, document that explicitly. Restoring older settings after subsequent writes
requires reconciliation against current local/server contents; never prescribe deleting state or blindly restoring
an old baseline as routine update recovery.

## Out of scope

Server share/auth redesign, folder ACLs, cross-share automatic moves, host provisioning/deployment, mobile background
execution guarantees, community-registry publication and changing Obsidian configuration synchronization.

## Implementation notes

Implement in reviewable stages: reproduce/classify ordinary sync and invalid persistence transitions; correct those
with regression fixtures; add bulk remote recovery; verify update continuity and document the short upgrade path.
Do not substitute bulk recovery for fixing ordinary synchronization.

Investigation for this ticket was read-only against source/documentation and synthetic test definitions. No tests
were executed, no phone state was inspected, and no live server, household files or deployment was accessed.
