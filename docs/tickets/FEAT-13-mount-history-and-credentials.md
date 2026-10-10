# FEAT-13: Mount History and Credential Workflows

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)

## Problem and Desired Behavior

History, device/version metadata and credential dialogs currently use one selected share. A composite vault must
route each action to its owning mount and distinguish identical relative filenames without retargeting legacy grants.

## Dependencies

- Hard, implemented: [FEAT-10/11](../COMPOSITE_MOUNT_DOWNLOADS.md) for resolver, ownership tokens, per-mount state,
  mutable-stage guards and reconciliation UI integration.
- FEAT-12 conversion is not required: fresh mounts provide complete contexts. Coordinate shared settings/UI edits.
- Preserve [FEAT-04 credential/history contracts](../CLIENT_SHARE_SELECTION.md) and existing v2 routes.

## Requirements

- File history, historical file/blob reads, device listings/versions and version metadata use the resolved mount's
  stable share ID and share-relative path. Pin revisions and verify bytes. Identical filenames/revisions in sibling
  mounts never share local caches, source identity or recovery metadata. Local-only paths do not invoke remote reads.
- Keep `ObsidiSync History` snapshots at the local root, excluded from all shares. Persist mount/share ownership
  alongside source path/revision; existing unbound records remain legacy/local evidence, never guessed assignments.
  Historical restoration uses owning-mount guarded application/backup and cannot clear reconciliation implicitly.
- Show selected mount/share context in dialogs and reconciliation-required markers in history. Read-only/download-only
  modes cannot mutate metadata; writable actions use fresh authority and FEAT-11's generation/barrier checks.
- Share-native credential inventory/create/revoke explicitly selects a mount and rechecks session/configuration/
  capability. Request read grants explicitly; read-only members cannot revoke and receive host-operator guidance.
  Display immutable scope, staged/active lifecycle, exact share-ID Basic/OCS identity and DAV/Nextcloud URLs.
- Legacy credential inventory uses retained original server/user/vault context, never a mount's ID/label/capability.
  Missing context is not reconstructed. Only the legacy `allowed` management header enables mutation; missing/unknown/
  denied disables controls while authorized inventory remains visible. Server mutation checks remain authoritative.
- Closing clears one-time secrets; do not save them in plugin settings or recover them from inventory. Lost creation
  response requires inventory review and intentional reissue, never automatic create retry. Stale dialogs after
  login, detachment or configuration/move changes cannot act on another mount; consume shared action guards.
- Preserve offline explicit activation of staged grants. Active grants remain independently usable after creator
  membership loss/disable until explicit revocation or share retirement. Explain operator inventory/revocation;
  mount detach does not revoke. Preserve legacy Saber settings/URLs and mapped-share background behavior, which may
  exceed its DAV folder scope. New share grants do not enable Saber scanning/rendering/pushing.
- Credential/metadata actions do not authorize file uploads, resolve local barriers or bypass application/write
  recovery. Carry verified OIDC/development identity rules; no v1 file fallback on denied v2 access.

## Proposed Implementation

Replace implicit `GitService` read/metadata destination selection with explicit mount contexts from FEAT-10; consume
FEAT-11 guarded mutations. Adapt `fileHistoryView`, history snapshot/version settings and device-password UI/service
to scoped ownership and dual inventories. Preserve the narrow original-namespace legacy credential exception;
do not generalize it to registration, sync or historical file reads. Document mount context and independent grants.

## Acceptance Criteria

- Equal relative paths in two mounts show only their own history, bytes, metadata and reconciliation markers.
- Snapshot reuse/restore cannot cross mounts; legacy unbound history remains distinguishable and local-only.
- Read-only metadata actions fail closed; stale dialogs cannot retarget after account/configuration/move changes.
- Share and legacy grant inventories remain separate with independently authorized mutation controls.
- Creation secrets clear on close and are never persisted; lost responses never auto-reissue grants.
- Grant staging/activation, independent lifetime and legacy Saber continuity remain unchanged.

## Testing and Manual Verification

Extend history/credential UI tests and real-server composite fixtures for identical paths, denied historical/blob/
device/metadata requests, immutable binding, capability changes, legacy header matrix and stale modal actions.
Check inventory secrecy, lost responses and staged/active lifecycle without real credentials. Run plugin/build/Rust/
e2e suites in Ubuntu/WSL; preserve WebDAV negative authorization/traversal/cross-share regressions. Manually inspect
both mount histories and both credential sections on disposable desktop/mobile vaults. Update client docs/README
with grant lifetime, host activation/revocation and retained legacy context; do not claim third-party live acceptance.

## Out of Scope

Conversion archive ownership belongs to FEAT-12; move/import approval belongs to FEAT-11/14. No new server endpoints,
Saber provisioning, account administration, deployment or production credential operations.
