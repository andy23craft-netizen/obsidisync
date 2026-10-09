# FEAT-04C: Writable Share Synchronization and Conflict Workflows

**Status:** Proposed implementation
**Owner:** Obsidian plugin and Rust integration
**Parent:** [FEAT-04](FEAT-04-client-share-selection-and-migration.md)

## Problem

Current writable synchronization, initial force-push, conflicts and metadata actions use v1 registration/paths and
cannot consume selected-share capabilities or durable local preservation barriers.

## Desired Behavior

A read-write member synchronizes one selected v2 share with existing upload, history, conflict and recovery
workflows intact. Capability loss stops writes without losing edits; restored access respects explicit reconciliation.

## Current Behavior

GitService.performSync registers before collecting/staging changes; uploadBuffer stages chunked bytes.
forcePushLocal probes and explicitly replaces server contents. resolveConflicts uploads choices to /resolve.
ConflictResolverModal combines pending server conflicts with marker scans. Server v2 already supplies corresponding
sync/upload/resolve/InkVault/device/version endpoints; share configuration is host-local, with no v2 register.

## Requirements

- Route writable sync/uploads/chunks/completion and server conflict operations through A's selected share.
  Preserve changes, deletes, attachments, device identity, histories/references and initial reconciliation.
  V2 must not invoke registration; preserve intentional mapped/old-server v1 behavior.
- Finish upload-side explicit initial reconciliation/force-push against the selected share. Preserve confirmation
  and remote-concurrency checks; never silently upload old-vault contents merely because a share was selected.
- Use B's guarded application, per-file baselines and recovery records. A completion-time whole-vault scan cannot
  acknowledge edits made during transfer that were never uploaded. Preserve interrupted progress and pending state.
- Check current capability before write work. Stop issuing writes on observed downgrade/403 without treating it as
  expired login or automatically retrying through v1. Server checks remain authoritative during in-flight races.
- Respect B's persisted barrier: unresolved or previously blocked edits require explicit reconciliation after write
  restoration. Other safe workflows must not accidentally clear or upload those records.
- Preserve server text/binary/edit-delete conflict behavior, pending-conflict recovery, explicit /resolve actions
  and conflict UI. Local-only B records remain distinct; read-only users see no server-mutating conflict actions.
- Preserve InkVault handling and its client feature gates, history/device versions, device listing and mutable
  version metadata through their audited v2 equivalents. Capability-gate all mutating entry points.
- Preserve upload/download failure and retry behavior, checksum checks and existing initial-sync/local backup
  recovery. Do not promise persisted byte-offset upload continuation the current client does not implement.
- Preserve normal startup/timer/manual/close scheduling and understandable queued/error/progress status using A/B.
  Re-login or a sync error must not reset state.

## Dependencies

[Implemented FEAT-04A](../CLIENT_SHARE_SELECTION.md) and
[Implemented FEAT-04B](../CLIENT_SHARE_SELECTION.md) are hard dependencies.
D is independent credential work; it is not needed for native writable sync.

## Proposed Implementation

Extend GitService writable operations to use A's destination routing and B's state/application ownership.
Update initial-sync, main, conflict resolver and history/version actions end-to-end rather than patching only /sync.
Reuse existing request/response models where compatible. Inspect server contracts before any proposed Rust change;
report security/product contradictions rather than inventing a new API or narrowing the route audit.
Tests/e2e must exercise real published share roots and compatibility mappings with synthetic authentication.

## Testing and Acceptance

- Test selected-share read-write Markdown/binary sync, concurrent edits, text/binary/delete conflicts and resolution.
- Test histories, device/version metadata, references and InkVault positive/negative capability paths.
- Test downgrade between staging/write steps, write denial, restart/re-upgrade and explicit reconciliation barriers.
- Test edits during upload/download, failed/acknowledgement-lost sync, partial staging, interrupted download and retry;
  prove unsent bytes are not silently overwritten or marked synchronized.
- Test explicit force-push reconciliation and cancellation/failure without silent state retargeting.
- Preserve old-server and mapped v1 tests; inaccessible shares cannot leak content/metadata or trigger fallback.
- Update user workflow/recovery documentation. Run required Rust/plugin/end-to-end/packaged suites with synthetic,
  disposable data when this completes FEAT-04; otherwise run focused relevant checks and preserve integration coverage.

## Manual Verification

Two devices synchronize Markdown and attachments to one selected share, merge independent edits and explicitly
resolve overlapping edits. Errors retain local edits and useful status. Downgrade blocks writes, and re-upgrade
requires reconciliation for preserved edits. No private share appears through lists/history/blob access.

## Non-Goals and Boundaries

No credential lifecycle UI (D), composite routing, authentication redesign or expanded server migration tooling.
No production access, deployment, live migration, Marvin/Harmony changes or ARM64 production image publication.
