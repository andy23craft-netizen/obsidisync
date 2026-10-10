# FEAT-11: Safe Writable Mount Synchronization

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)

## Problem and Desired Behavior

Fresh composite mounts need explicit writable synchronization without cross-share leakage or stale work surviving
a detected move. Extend existing guarded single-share writes to independently recoverable mounts, including their
initialization, local reconciliation and server conflict UI.

## Dependencies

- Hard: [FEAT-10](FEAT-10-scoped-mount-downloads.md), which establishes mount views, generation/barrier lifecycle,
  action tokens, scheduling, persistence and fresh mount setup.
- Preserve [FEAT-04 writable/recovery contracts](../CLIENT_SHARE_SELECTION.md) and existing v2 server interfaces.

## Current Behavior

`GitService.performShareSync`, `submitShareChanges`, `uploadShareBuffer` and `recoverShareWrite` use singular
`activeShare`. Write journals retain captured hash/deletion evidence in staging/submitted/accepted phases;
`ShareReconciler` distinguishes local preservation from server conflicts. These are the behavior to retain per mount.

## Requirements and Proposed Contract

- Enable writes explicitly per initialized read-write mount. Initial downloads stay download-only. Offer separately
  confirmed initial upload replacing only the named share, including remote-only deletions, using verified local
  backup, captured bytes and a real remote base. Adding a mount never uploads an existing folder implicitly.
- Scope scanning, chunk staging, sync, conflict resolution, acknowledgement and merged application to its mount.
  Reuse FEAT-10's resolver and action tokens; never duplicate routing rules or reuse legacy baselines.
- Recover application/write journals before collecting new uploads. Persist exact captured hashes/deletions before
  staging. Advance baselines only for accepted captured bytes, not observed heads or end-of-sync scans. Detect edits
  during transfer and preserve them as reconciliation barriers. Do not replay consumed upload IDs.
- Immediately before upload initialization, every chunk/completion, sync/resolve submission and mutable write stage,
  check mount ID/binding/configuration revision/move generation, capability and barriers. Recheck after awaited
  negotiation, journal saves and other preparation immediately before dispatch. Downstream metadata/import actions
  consume this same guard. Recheck before response acknowledgement, barrier changes and destructive local application.
- FEAT-10 move detection invalidates captured/queued work. Stale work cannot mutate, acknowledge, release barriers or
  authorize deletion. Barrier persistence failure blocks affected writes; unrelated mounts remain eligible.
- Dispatched requests may already have committed despite cancellation. Keep original staging/submitted/accepted
  evidence. Stale callbacks may retain responses as evidence only. Fresh recovery with current tokens uses authorized
  full snapshots plus server conflict reads: exact captured matches establish only that version's outcome;
  divergence/conflict/denial remains unresolved. Never infer rollback or undo a potentially committed disclosure.
  Outcome recovery alone cannot clear move barriers or approve source deletion.
- Provide mount-specific local reconciliation and server conflict workflows. Keep local retains an upload barrier;
  Back up and use remote refreshes target, verifies fresh backup and guards application without uploading.
  Back up and upload local is separately explicit, with fresh authority/base and concurrent-conflict handling.
  Server resolver preserves binaries and checksum-verified marker views; markers are not contents at a Git head.
- Explicit reconciliation can release only the selected barrier after evidence is saved and outcome/local choice is
  resolved. A move-related decision names the affected endpoints and never silently approves the other endpoint's
  deletion/upload. Import-specific release/consent is owned by FEAT-14 and uses these primitives.
- Capability downgrade or HTTP 403 stops subsequent writes and persists preservation barriers. Restart, permission
  restoration or re-login never auto-uploads retained edits. Read-only UI permits local actions only. Authorization
  denial never falls back to v1. Preserve OIDC/development identity rules and InkVault omission/managed PDF gates.

## Proposed Implementation

Adapt `GitService` writable initialization/submission/recovery and conflict/reconciliation modals to explicit mount
contexts; extend settings/initial-sync UI with per-mount write decisions. Preserve serialized settings snapshots and
scoped `VaultState` evidence from FEAT-10. This ticket owns write guard call sites and fresh recovery, not rename event
detection, conversion archives, history/credential presentation or the import workflow.

## Acceptance Criteria

- Two writable mounts synchronize text, deletion and binary changes only to their shares with independent conflicts.
- Initial upload previews the destination and replacement; failure preserves backup/recovery and never writes siblings.
- Moves before submission or during staging stop stale work; moves after submission prevent stale acknowledgements.
- Lost-response/restart recovery identifies only captured accepted versions and retains move barriers; consumed IDs
  are not replayed, and an unaffected third mount can synchronize.
- Local choices, downgrade and restored access never implicitly approve uploads or cross-endpoint deletion.
- Server conflicts and ambiguous disk/network outcomes remain recoverable and attributable after restart.

## Testing and Manual Verification

Add writable real-server composite e2e for text/binary conflicts, local/remote deletion, partial staging, membership
change and storage isolation. Inject moves before submission, during chunks, after submission before acknowledgement,
lost responses and restart with unresolved work. Assert stale guards at every stage and current recovery retaining
barriers. Exercise settings/login changes and unchanged legacy v1 behavior. Run the plugin/build/Rust/e2e commands
listed in FEAT-10 in Ubuntu/WSL with disposable data. Manually verify per-mount initial upload/enable writes,
conflict/reconciliation and interrupted transfer on desktop/mobile. Update writable/recovery documentation.

## Out of Scope

Conversion/detachment, history/credential workflows and explicit import belong to FEAT-12/13/14. No protocol redesign,
production migration, deployment, sibling repository edits or share-native Saber provisioning.
