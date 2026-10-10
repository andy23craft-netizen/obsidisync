# FEAT-10: Scoped Mount Downloads

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)

## Problem and Desired Behavior

The plugin has one selected share and whole-vault scanning. Support independently authorized Personal/ and Harmony/
mounts with guarded downloads, isolated recovery and truthful status. This ticket owns the shared mount boundary
because writable sync, conversion, history and import must use one resolver and persistence model.

## Current Behavior

`src/settings.ts` stores singular pending/active selection. `src/shareSelection.ts` binds server/identity;
`src/shareReconciliation.ts` owns baselines, application/write journals and barriers. `src/vaultState.ts` scans the
whole vault; `src/gitService.ts` negotiates a selected share. `src/main.ts` serializes captured settings snapshots
and receives post-mutation rename events. Preserve [FEAT-04 contracts](../CLIENT_SHARE_SELECTION.md).

## Dependencies

- Hard prerequisite: implemented FEAT-04 and [server share contracts](../SHARE_STORAGE_AND_MIGRATION.md).
- FEAT-11 adds writes; FEAT-12 converts existing configurations. Neither is needed for fresh empty-vault downloads.

## Requirements and Proposed Contract

- Persist a versioned composite mode with ordered stable mount IDs, safe prefix, opaque share ID/display cache,
  normalized server, verified identity/authentication binding, configuration revision, monotonic move generation,
  pending/active state, capability/mode, complete per-mount `ShareDownloadState`, errors/status and retry evidence.
  One server/session, nonempty nonoverlapping prefixes, no duplicate share. Reordering changes presentation only.
- Provide a fresh composite setup path only for a new empty vault without prior sync/recovery evidence. Selecting
  shares never changes files or authorizes writes. Existing v1/selected-share settings remain untouched and usable;
  attempts to convert existing files/state explain that explicit conversion is required. No automatic migration.
- A shared resolver returns mount plus share-relative path or local-only. Use segment boundaries, traversal/absolute
  rejection and collision/alias checks on supported adapters. Validate remote paths before joining. Outside mounts
  is local-only. Exclude `.git`, `.obsidian`, `.obsidian-git-sync`, `.trash`, caches, plugin settings and
  `ObsidiSync History` on both sides of translation. Do not broaden legacy/single-share ignore behavior globally.
- Scope paths, capture, backup, guarded application and manifests through a mount-aware vault view. All per-file
  state uses share-relative paths; backup evidence identifies mount/prefix. Root recovery data remains local-only.
- Download initialization requires explicit fresh checksum-verified backups and reconciliation within the prefix.
  Use intent-before-write, final byte checks and conservative resume. Never overwrite an intervening edit/deletion.
  Full v2 reads use `changes: []`, `baseHead: null`, empty manifest, no registration or document/metadata writes.
  Pin blobs to returned head and verify inline/reference bytes. Observed head never acknowledges local edits.
- Retain local/server conflict separation and downgrade barriers. Keep local does not approve upload; restored
  permission or re-login cannot erase barriers. Preserve InkVault source omission and managed PDF rules; ordinary
  exported attachments work. Do not advertise `inkVaultNotesV1` or enable source editing/Saber provisioning.
- Serialize mount scheduling initially. Startup/timer/manual/close run eligible mounts independently; failures do
  not corrupt or suppress later eligible siblings. Shared login failure may pause all without clearing state.
  Display per-mount capability, mode, pending counts and retry status; no writable controls until FEAT-11.
- Shared action tokens capture mount ID, binding, prefix, configuration revision and move generation. Recheck after
  asynchronous preparation before local application/state acknowledgement. Stale callbacks cannot clear barriers.
  Preserve serialized captured settings snapshots and reject inconsistent composite state at startup without v1 fallback.
- Own post-mutation cross-boundary file/folder rename detection, including local-only endpoints and root renames.
  Synchronously advance affected generations and establish barriers, then save both endpoints/records together.
  Save failure retains an in-memory stop; persisted barriers survive restart. Block affected paths' destructive
  application; reads may gather evidence. Missing mount folders are not bulk-delete approval. No automatic undo.
  Unaffected mounts continue. Plugin-originated cross-mount moves are rejected. Document unobserved offline/external
  changes and the adapter's external-writer race; routing is not security against deliberate local copying.

## Implementation Ownership

Extend settings/selection/reconciliation, scoped `VaultState`, `GitService` read scheduling and main/settings/chooser
entry points as one capability. Expose reusable token/barrier checks to FEAT-11/12/13/14. FEAT-11 owns mutation-stage
integration and explicit reconciliation release. Composite history/credential controls stay unavailable with an
explanation until FEAT-13; old singular routes must never accidentally target a mount.

## Acceptance Criteria

- Two authorized mounts download identical relative filenames/attachments into distinct prefixes and retain separate
  baselines, heads, recovery, errors and retry state across restart.
- Unsafe/overlapping/case-alias prefixes and protected remote paths cannot write outside their allowed scope.
- Initial/resumed download preserves edits and uncertain disk state; one blocked file/mount leaves safe siblings usable.
- Read-only/download-only operations leave share storage fingerprints unchanged and never fall back to v1 on denial.
- Rename detection saves both affected generations/barriers; stale applications cannot acknowledge or overwrite moved
  contents. Local-only and folder/root cases fail closed without remote deletion.
- Fresh empty-vault setup is usable; existing installations are not silently converted and retain prior behavior.

## Testing and Manual Verification

Add resolver/adapter/state fixtures for path aliases, protected paths, identical relative paths, checksum and backup
failures, interruption, login/config changes, move detection/save failure and sibling scheduling. Extend real-server
read-only e2e with private/shared mounts and denied discovery/content/blob requests; fingerprint server storage.
Run `npm run test:plugin`, `npm run build:plugin`, `npm run test:server`, `npm run test:e2e` in Ubuntu/WSL with synthetic
data. On disposable desktop/mobile vaults verify setup, offline edits, binaries, restart and readable per-mount status.
Update client documentation/README for fresh setup and local-only roots. Record automated versus human evidence.

## Out of Scope

Writes, existing-vault conversion/detachment, history/credential UI and import are downstream tickets. No server
authorization redesign, production operations, multi-server/account mounts or sibling repository changes.
