# FEAT-04: Client Share Selection and Safe Migration

**Status:** Proposed implementation subtask
**Owner:** Obsidian plugin and Rust integration
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Prerequisites:** Implemented server contracts in [Share storage and migration](SHARE_STORAGE_AND_MIGRATION.md)
and the [server implementation audit](FEAT-03-IMPLEMENTATION-AUDIT.md). FEAT-05 follows this ticket.

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
  write-capable credential creation or write-conflict actions; edits report a precise non-upload error.
  Read-grant issuance must explicitly request read capability rather than use the server's read-write default.
- Do not silently map old namespace/vault settings by label or clear old head/manifest. Preserve settings until the
  user selects a migrated share and reconciles, retaining existing backup-before-overwrite behavior.
- Preserve current OIDC/password and explicitly enabled development-token login, server compatibility checks,
  reference-file downloads, InkVault, history/conflict UI,
  device-password UI, and initial-sync workflow. Native share operations use v2; legacy grant management retains
  its explicitly authorized v1 context as specified below.
- One local vault maps to one share in this ticket. Keep state evolution compatible with FEAT-05 but do not add
  composite routing yet.

## Binding Integration Contracts

- Use GET /v2/shares, GET /v2/shares/{shareId}/sync-state and audited v2 equivalents. There is no v2 register.
  Read sync sends no changes and performs no remote refresh or mutable device/version bookkeeping.
- Select v2 using the advertised `shareSyncV2` feature, not the discovery response's API version number.
  `/v1/server/info` currently reports API version 1 while advertising v2 support. Preserve ordinary API compatibility
  validation and writable v1 with compatible older servers and mapped namespaces;
  retain old settings until explicit successful migration. Never fall back after share denial or infer a label mapping.
- Mandatory re-login for legacy issuer-less OIDC sessions must preserve head, manifest and recovery state.
  Development tokens require explicit development mode and distinct principal membership/mapping; never convert
  them into local/OIDC identities or suggest development mode for production.
- Share device-password creation returns staged grants. Show staging and required offline activation clearly;
  never promise immediate DAV use or rotate secrets to activate. Share-ID Basic/OCS identity and DAV/Nextcloud URLs
  must match the implemented contract. Distinguish native sessions from independent device/service credentials.
- Explain that membership removal/account disable does not revoke independent grants; operator inventory and
  explicit revocation are required. Do not enable Saber from a new share credential. Mapped legacy Saber remains
  supported, with its documented vault-wide export scope separate from DAV folder restrictions.

### Per-file read-only synchronization and local preservation

- Continue discovery, negotiation, history and empty-change read sync without server document mutation.
  Use per-file safe application, not a whole-vault pause when local edits exist.
- Apply a remote update/deletion only when the affected file is proven unchanged relative to its last successfully
  synchronized baseline. Preserve unsynchronized local bytes, local deletions and pending edits. Missing or uncertain
  baseline/modification evidence blocks application for that file; other proven-safe files continue downloading.
- Overlapping remote/local updates or deletions create a durable, visible reconciliation-required local conflict.
  Persist enough share/path, baseline and remote-version/deletion information to resume reconciliation after restart
  and remote advancement. Revalidate local modification state before applying downloaded bytes or deleting a file;
  edits during a download must not be overwritten.
- Keep remote observation/progress distinct from per-file synchronized baselines and blocked local state.
  Advancing the remote head must not mark preserved edits as synchronized, discard a blocked remote change, or make
  it unreachable on subsequent incremental sync. Never replace the synchronized manifest with a whole-vault scan
  that includes unapplied or unsynchronized edits. Interrupted application preserves progress and pending records.
- Capability downgrade preserves pending edits, existing server/local conflicts, heads/manifests and recovery state.
  Stop issuing uploads and write operations as soon as downgrade is observed; check current capability before write
  work, and stop on server write denial. The server remains authoritative if capability changes during a request.
  Continue safe reads. Persist previously blocked edits so restart or capability restoration cannot auto-upload them.
- Restoration of write access requires explicit reconciliation before unresolved or previously blocked edits may
  upload. While read-only, reconciliation is local-only; no server-mutating resolve, force-push, metadata or upload
  action is exposed. Local decisions must preserve data and cannot silently authorize later uploads.
- Reuse existing conflict/recovery machinery where compatible. Keep local preservation conflicts distinct from
  server merge conflicts: read sync returns an empty conflict list and does not create server conflict records.

### Explicit legacy DAV/Saber management context

- Retain the original `userSlug`/`vaultSlug` as explicit legacy management context after v2 selection, independently
  of selected stable `shareId`. Login updates must not silently replace this retained context. Do not infer a legacy
  namespace from share membership, a label or a share-ID URL; absent context means no implicit legacy management.
- List/create/revoke legacy grants through the existing
  `/v1/users/{userSlug}/vaults/{vaultSlug}/device-passwords[/{id}]` routes. The server must authorize the current
  principal against the original namespace, exact published mapping, current membership and operation capability.
  List requires read; creation/revocation requires read-write. Do not register or retarget a vault just to manage grants.
- Preserve legacy IDs, secrets, URLs, encryption/PDF settings and Saber behavior. Show legacy credentials separately
  from staged/active share-native grants. Do not convert, reissue or provision Saber through v2 grants.
- If authorization, membership or native compatibility no longer permits legacy management, explain the limitation
  without exposing inaccessible grant details. Retain context; do not delete or silently migrate it, retry with
  another namespace, or treat share selection as authorization. This intentional v1 management route is not sync
  fallback after v2 denial.
- Independent legacy grants may continue serving after creator membership removal even though that person's user
  session can no longer manage them. Native cutoff also disables these v1 management routes while named retained
  DAV/Saber exceptions may remain usable. Explain explicit host-operator inventory/revocation in these cases;
  do not weaken authorization or add a server API to bypass it.

## Proposed Implementation

Extend `IosGitSyncSettings`, protocol types, and `GitService` for v2 listing/capability/selected-share state and
routes. Update settings/login/initial-sync/history/conflict/device-password UI to require selection and explain
migration or read-only status. Keep `VaultState` whole-vault scanning for the selected share. Update TypeScript
tests/e2e fixtures and user documentation.

Separate selected-share sync routing from retained legacy management routing. Extend persisted client state with
per-file preservation/reconciliation records and safe application bookkeeping. Scope these records to the selected
server/share and preserve existing migration/recovery state. Existing `VaultState.applyServerFiles` writes/deletes
directly, so add guarded application rather than invoking it unchanged for read-only updates. Server `read_sync`
already supplies remote changes/head without mutation; no new server conflict API is required.

Relevant files: `src/settings.ts`, `gitService.ts`, `protocol.ts`, `serverFiles.ts`, `vaultState.ts`, `main.ts`,
`authLoginModal.ts`, `initialSyncModal.ts`, history/conflict/device-password components, `tests/*.test.ts`, e2e,
and `README.md`.

## Acceptance Criteria

- A signed-in user sees only authorized shares and can select one by stable ID for a local vault.
- Andy and Liz independently sync their private and Harmony shares through separate local vaults.
- Read-only selection completes discovery, negotiation, change/manifest retrieval, file/blob download, and history
  without a write-registration request or server mutation attributable to the client.
- Read-only local edits do not upload and report capability denial; mutating controls are absent/disabled.
- Mixed changed/unchanged files continue safe downloads; overlapping updates/deletions preserve edits and persist
  visible local reconciliation records. Uncertain state fails closed per file, including edits during download.
- Downgrade and restart preserve all pending state. Re-upgrade cannot auto-upload blocked edits, and remote head
  advancement cannot falsely mark them synchronized or lose pending remote changes.
- Old v1 settings cannot silently retarget or reset local state; user-directed migration reconciles explicitly and
  backs up before overwrite-local.
- Read-write v2 sync, history, conflicts, file references, and device-password management work for selected share.
- V2 selection preserves separate authorized v1 legacy management, legacy Saber grants and settings. Namespace
  mismatch, lost membership and cutoff explain unavailable management without discarding context or migrating grants.

## Testing and Validation

- Unit-test v2 endpoint construction, selection, capability rendering, API feature gating, legacy-settings migration,
  and state persistence.
- Mock/integration-test read-only flow to prove no register/upload request is emitted, then prove edit denial.
- Test mixed unchanged/edited files, offline edits, overlapping remote updates, remote deletion, uncertain baselines,
  edits during download, interrupted apply/restart, and advancing heads with blocked files. Assert preserved bytes
  and truthful per-file baselines; unaffected files continue and no server conflict record is created.
- Test read-write to read-only downgrade with pending uploads/conflicts/recovery, restart and write restoration.
  Verify writes stop on capability loss and blocked edits require explicit reconciliation before later upload.
- Test legacy listing/creation/revocation after v2 selection, authorized original namespaces, mismatches and other
  share members, creator removal, retained grant usability, native cutoff, and absent legacy context. Assert retained
  context, unchanged IDs/URLs/settings, and separate legacy versus staged/active share UI.
- Test discovery advertising `shareSyncV2` with API version 1, old servers without the feature, and v2 denial with
  no v1 sync fallback. Intentional legacy credential requests remain subject to their own authorization.
- Preserve/extend initial-sync, conflict, history, InkVault, blob-reference, and device-password tests for v2.
- Cover old-server v1 compatibility, missing mappings, denied shares without fallback, OIDC re-login preserving
  state, explicitly enabled development identity, capability downgrade/revocation, and staged read/write grants.
- Run required Rust, plugin, end-to-end and packaged-command suites with disposable data and synthetic credentials.
- Local completion is build/tests plus fixture/manual separate-vault share selection. Client deployment, live upgrade,
  and user reconciliation are separate operator steps.

## Documentation and Completion

Document interim separate-vault setup, selection, authentication exceptions, staged credentials, retained legacy
management and per-file read-only reconciliation, including explicit recovery after write capability returns.
Implement FEAT-04 then FEAT-05 before one separately authorized coordinated production migration after validation.
Do not deploy, access production data, run a live migration or modify Marvin/Harmony repositories.
Completion means local plugin and relevant integration tests pass; it does not assert a live migration or
production-client verification.

## Out of Scope

- Prefix mounts/cross-share moves (FEAT-05), server authorization/storage/migration implementation (FEAT-03), and
  Marvin/Harmony repository changes.
