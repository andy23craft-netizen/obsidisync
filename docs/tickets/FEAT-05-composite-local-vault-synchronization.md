# FEAT-05: Composite Local Vault Synchronization

**Status:** Proposed implementation subtask
**Owner:** Obsidian plugin
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** [FEAT-04](FEAT-04-client-share-selection-and-migration.md) - hard dependency; FEAT-03 share
authorization is implemented; its binding runtime contracts are in
[Share storage and migration](SHARE_STORAGE_AND_MIGRATION.md).

## Problem

One-share-per-local-vault is secure but makes people switch vaults between private and Harmony work. The plugin
currently scans one whole local vault with one remote state, so it cannot route files to independently authorized
shares.

## Desired Behavior

Each user configures one local vault with `Personal/` mapped to their private share and `Harmony/` mapped to the
shared share. Every mount has independent ID, capability, head, manifest, initial-sync/recovery decision, conflicts,
status, and retry. Local routing never weakens the server share boundary.

## Requirements

- Persist ordered `{localPrefix, shareId, display cache, perShareSyncState}` mounts. Prefixes are safe, non-empty,
  non-overlapping, and never claim root/protected configuration paths; one share is not mounted twice.
- Scan, change collection, upload/download, blob retrieval, deletion, manifest/head tracking, initialization, and
  conflicts only inside the owning prefix, with share-relative server paths.
- One mount's error/conflict/recovery action cannot reset, overwrite, or block safe retry of another. Read-only
  mounts retain v2 download behavior and reject writes.
- Treat `.obsidian`, `.obsidian-git-sync`, `.trash`, cache data, and plugin settings as composite-root local state;
  none may enter Personal/Harmony through path handling.
- Reject cross-mount rename/move before network activity. Offer explicit copy/import, destination sync validation,
  then separately confirmed source deletion; retain both copies after partial failure.
- Preserve Markdown link text; links grant no access and are not rewritten. Attachments follow their local mount.
- Work through Obsidian's adapter on iOS/iPadOS/macOS without symlinks, union mounts, or desktop-only setup.

## State Migration and Server Constraints

FEAT-04's selected-share state is a prerequisite, not current composite functionality. Convert it only through
explicit user-chosen prefixes and per-mount reconciliation. Preserve prior settings/head/manifest and local files
until successful conversion; never infer share identity from Personal/Harmony labels. Back up before overwrite-local.

Keep capability, pending upload/conflict/recovery and retry state isolated per mount. Membership loss, expired login,
unpublished/retired share or credential revocation must not reset another mount or delete existing local copies.
Do not fall back to a legacy namespace after denied v2 access. Read-only mounts use non-mutating v2 negotiation/sync.

Carry FEAT-04's issuer-bound OIDC re-login and explicit development-principal behavior without aliasing identities.
Device/service grants remain independent and staged until explicit offline activation; mount changes cannot retarget
their immutable share/folder/capability or implicitly enable Saber. Legacy Saber stays within its original mapped share.

## Proposed Implementation

Replace singular selected-share state with versioned mount configuration and per-mount state. Add a normalized path
resolver that maps each vault-relative path to exactly one mount or composite-local excluded root. Refactor
`VaultState` and `GitService` to scan/apply beneath a mount while translating local-prefixed and share-relative
paths. Schedule/report initial sync, conflict, error, and retry per mount under the current overall sync command.

Add an explicit copy/import workflow rather than cross-share rename. It copies content/attachments, verifies
destination sync, then asks to delete source; failure retains source and reports recovery paths. Update settings,
status, initial-sync, conflict/history/device-password UI, ignore rules, tests/e2e, and README.

Relevant files: `src/settings.ts`, `protocol.ts`, `gitService.ts`, `vaultState.ts`, `main.ts`, `initialSyncModal.ts`,
history/conflict/device-password/settings UI, `ignore.ts`, tests/e2e, and `README.md`.

## Acceptance Criteria

- `Personal/` and `Harmony/` map to different authorized shares and retain independent heads/manifests/state.
- A file or binary attachment reaches only its mount's share; sibling mounts receive no path, metadata, or bytes.
- Initial reconciliation, backup/overwrite-local, conflict resolution, and retry occur per mount. Harmony conflict
  cannot alter Personal state.
- Root `.obsidian` and related local-only paths never upload to either share.
- Same-mount rename works; cross-mount rename is rejected before remote calls. Explicit import retains source until
  destination sync succeeds and user confirms deletion.
- Links remain unchanged and documented; inaccessible cross-share links trigger no copying.
- Adapter-based behavior works on supported desktop and mobile platforms.

## Testing and Validation

- Unit-test path normalization, prefix collision rejection, resolver behavior, per-mount state migration, and root
  exclusions.
- Add client/e2e tests for isolated scanning/apply/manifests, attachment routing, references, independent initial
  sync/recovery/conflicts/retries, read-only mounts, same-mount rename, rejected cross-mount rename, and failed
  import retaining source.
- Test explicit single-share-to-mount conversion, retained old state after failure, authorization loss without
  fallback or sibling mutation, and destination verification before separately confirmed source deletion.
- Run required Rust, plugin, end-to-end and packaged-command suites using disposable data and synthetic credentials.
- Exercise existing mobile-compatible adapter mocks and perform fixture manual checks on supported desktop/mobile.
- Local completion is build/tests plus fixture/platform checks. Production rollout, user migration, and live
  verification remain operator activities with backup and per-mount reconciliation.

## Documentation and Completion

Document owner-specific Personal mapping, Harmony setup, links, attachments, import, root exclusions, and recovery.
Completion means local implementation/tests pass; it does not assert deployed or live-verified behavior.
After FEAT-04 and FEAT-05 validation, production migration remains one coordinated separately authorized operation.
No production access, deployment, live migration or Marvin/Harmony repository changes are authorized.

## Out of Scope

- Server share authorization/account administration/v2 storage contracts, atomic cross-share moves, link rewriting,
  union filesystems, sibling repository edits, or document-semantic changes.
