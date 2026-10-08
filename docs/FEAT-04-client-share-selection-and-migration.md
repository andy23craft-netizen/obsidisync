# FEAT-04: Client Share Selection and Safe Migration

**Status:** Proposed implementation subtask
**Owner:** Obsidian plugin and Rust integration
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** [FEAT-03](FEAT-03-share-scoped-storage-api-webdav-and-migration.md) - hard dependency.

## Problem

The plugin persists one `userSlug`, `vaultSlug`, head, and manifest, and calls mutating v1 registration before
each sync. It cannot discover/select authorized stable share IDs or migrate old settings without accidental reset.

## Desired Behavior

This is the first usable household release: each local Obsidian vault selects and synchronizes one authorized v2
share. Andy can use separate Andy Private/Harmony vaults; Liz can use Liz Private/Harmony vaults. A read-only share
works for discovery, negotiation, download, and history without write registration; local write attempts fail
clearly. Existing settings require intentional mapping and reconciliation.

## Requirements

- Discover server-authorized shares and persist selected stable `shareId`, display cache, one-share head/manifest,
  initial-sync state, conflict state, and recovery state. Labels are display only, never authorization.
- Build v2 paths from selected share ID and use the server's non-mutating sync-state/negotiation path for read-only
  and initial read sync. Do not emit registration/upload solely to download.
- Display capability-aware settings/status. Read-only shares permit browse/history/download but do not expose
  credential-creation or write-conflict actions; edits report a precise non-upload error.
- Do not silently map old namespace/vault settings by label or clear old head/manifest. Preserve settings until the
  user selects a migrated share and reconciles, retaining existing backup-before-overwrite behavior.
- Preserve current OIDC/password login, server compatibility checks, reference-file downloads, history/conflict UI,
  device-password UI, and initial-sync workflow using v2 equivalents.
- One local vault maps to one share in this ticket. Keep state evolution compatible with FEAT-05 but do not add
  composite routing yet.

## Proposed Implementation

Extend `IosGitSyncSettings`, protocol types, and `GitService` for v2 listing/capability/selected-share state and
routes. Update settings/login/initial-sync/history/conflict/device-password UI to require selection and explain
migration or read-only status. Keep `VaultState` whole-vault scanning for the selected share. Update TypeScript
tests/e2e fixtures and user documentation.

Relevant files: `src/settings.ts`, `gitService.ts`, `protocol.ts`, `serverFiles.ts`, `vaultState.ts`, `main.ts`,
`authLoginModal.ts`, `initialSyncModal.ts`, history/conflict/device-password components, `tests/*.test.ts`, e2e,
and `README.md`.

## Acceptance Criteria

- A signed-in user sees only authorized shares and can select one by stable ID for a local vault.
- Andy and Liz independently sync their private and Harmony shares through separate local vaults.
- Read-only selection completes discovery, negotiation, change/manifest retrieval, file/blob download, and history
  without a write-registration request or server mutation attributable to the client.
- Read-only local edits do not upload and report capability denial; mutating controls are absent/disabled.
- Old v1 settings cannot silently retarget or reset local state; user-directed migration reconciles explicitly and
  backs up before overwrite-local.
- Read-write v2 sync, history, conflicts, file references, and device-password management work for selected share.

## Testing and Validation

- Unit-test v2 endpoint construction, selection, capability rendering, API feature gating, legacy-settings migration,
  and state persistence.
- Mock/integration-test read-only flow to prove no register/upload request is emitted, then prove edit denial.
- Preserve/extend initial-sync, conflict, history, blob-reference, and device-password tests for v2.
- Local completion is build/tests plus fixture/manual separate-vault share selection. Client deployment, live upgrade,
  and user reconciliation are separate operator steps.

## Documentation and Completion

Document interim separate-vault setup, selection, upgrade order, and reconciliation. Completion means local plugin
and relevant integration tests pass; it does not assert a live migration or production-client verification.

## Out of Scope

- Prefix mounts/cross-share moves (FEAT-05), server authorization/storage/migration implementation (FEAT-03), and
  Marvin/Harmony repository changes.
