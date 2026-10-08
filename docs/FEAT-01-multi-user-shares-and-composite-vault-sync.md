# FEAT-01: Multi-User Shares and Composite Vault Sync

**Status:** Client implementation remains
**Owner:** Obsidian plugin
**Remaining subtasks:** [FEAT-04](FEAT-04-client-share-selection-and-migration.md), then
[FEAT-05](FEAT-05-composite-local-vault-synchronization.md).

## Problem and Current Behavior

The server implements accounts, typed principals, share membership, published share storage, v2 APIs, scoped DAV
grants, and offline migration/recovery. Its contracts are documented in
[Share storage and migration](SHARE_STORAGE_AND_MIGRATION.md); inspected surfaces and disposable automated evidence
are recorded in the [server implementation audit](FEAT-03-IMPLEMENTATION-AUDIT.md).
FEAT-02 and FEAT-03 have no remaining implementation work. Actual-client acceptance and production verification
remain outstanding.

The plugin still stores one user/vault namespace, head and manifest and calls writable v1 registration before sync.
It cannot select a v2 share or route a composite local vault to independent shares.

## Desired Behavior

Andy sees Andy Private and Harmony; Liz sees Liz Private and Harmony. Private content and metadata remain
inaccessible to the other person. First support separate local Obsidian vaults selecting one share each; then support
one local vault with Personal/ and Harmony/ mounts. Each share keeps independent heads, manifests, conflicts,
initial reconciliation, recovery and retry state.

Shares use stable opaque IDs. Names are display labels. A share is the storage and authorization boundary;
folder filtering and client UI are not privacy controls.

## Remaining Implementation

### FEAT-04: One-share selection and safe client migration

Discover authorized shares, select by stable ID and synchronize through the implemented v2 routes.
Use non-mutating sync-state and empty-change read sync for downloads; v2 has no registration endpoint.
Read-only users can negotiate, retrieve manifests, history, files and binaries without mutation.

Select v2 by `shareSyncV2`, independently of the discovery API version number; never fall back after v2 denial.
Read-only synchronization applies remote changes per file only when local state is proven unchanged. Preserve local
edits on overlapping updates/deletions, persist local reconciliation records, and continue unaffected downloads.
Uncertain files fail closed. Capability downgrade preserves pending state; restoration never auto-uploads blocked
edits without explicit reconciliation. Remote progress must not falsely advance their synchronized baselines.

Retain original user/vault as separate legacy management context after share selection. Existing v1 routes still
authorize that namespace for legacy DAV/Saber grants; share membership alone cannot grant management access.
Distinguish legacy grants from staged/active share-native grants. Unavailable management retains context and explains
the limitation, including lost membership or native cutoff; host-local inventory/revocation remains available.

Preserve existing login, sync, history, conflicts, InkVault, reference downloads, device-password and recovery
workflows. Keep intentional v1 operation with compatible old servers and explicitly mapped namespaces.
Do not infer mappings from labels, silently switch protocols after authorization failure, or clear old sync state.
Require explicit share selection/reconciliation and preserve backup-before-overwrite behavior.

### FEAT-05: Composite local vault

Introduce safe non-overlapping prefixes with independently persisted share state. Scope scans, uploads, downloads,
deletes, histories and recovery to the owning mount. A failed Harmony operation must not corrupt Personal state.
Exclude composite-root configuration, caches, plugin settings, .obsidian-git-sync and .trash explicitly.

Reject cross-share rename/move before remote effects. Offer explicit copy/import, verify destination synchronization,
then separately confirm source deletion. Partial failure retains recoverable copies; no atomicity is promised.
Preserve Markdown links unchanged. Links grant no access, and inaccessible targets do not trigger copying.
Attachments follow their mount. Use Obsidian adapters on supported desktop/mobile platforms without filesystem mounts.

## Binding Server and Authentication Constraints

- Authenticate and authorize before content or metadata access. Inaccessible shares remain indistinguishable from
  nonexistent shares. User membership removal blocks subsequent user-session access; local copies cannot be erased
  remotely with a security guarantee.
- Preserve writable v1 through exact reviewed namespace-to-share mappings and original namespace authorization.
  Membership alone never grants another person's legacy namespace. No inferred mapping, legacy fallback, second
  writable tree, or automatic cutoff.
- OIDC identity is the verified issuer/subject pair. Legacy issuer-less sessions require fresh login, an approved
  compatibility exception. Re-login must preserve client sync state, vault data and memberships.
- Local accounts use immutable IDs. Development authentication resolves a separate stable development principal,
  requires explicit enablement, membership and mapping, and obeys ordinary authorization. Packaged production
  defaults to OIDC and rejects development tokens; password mode must also be explicitly selected.
- Device/service credentials are independent revocable grants bounded by immutable share, folder and capability.
  Read-only membership cannot issue a write grant. New share credentials are staged until explicit offline
  activation after publication; preserve IDs and secrets. Membership removal/account disable does not revoke an
  active grant. Explain operator inventory and explicit revocation; retirement makes grants unusable.
- Share DAV/Nextcloud Basic identity and URLs use the exact share ID; bearer resolves the same grant. Native login
  tokens and DAV credentials are distinct. Harmony uses its dedicated independently revocable scoped service grant,
  never activated automatically.
- Preserve mapped legacy Saber authentication, encryption/PDF settings, URLs, rendering and background pushing.
  Historical vault-wide tablet export can exceed DAV folder scope within the original mapped share. New share
  credentials never provision Saber. Share-native Saber configuration remains deferred to a separate future feature.
- Publication is coordinated by one validated manifest with an offline pending journal/startup barrier.
  Separate JSON renames are not a transaction. Client work must not bypass unpublished/retired shares.

## Integration and Production Boundaries

Implement FEAT-04, then FEAT-05, followed by one separately authorized coordinated production migration after
validation. No production access, deployment, live migration or Marvin/Harmony repository changes are authorized
by these tickets.

Production requires inventory of clients, vaults, remotes and grants; approved mappings and excluded vault handling;
a protected verified complete backup; dry-run/collision checks; staged complete copies; validation and coordinated
publication; then explicit client reconciliation. Unmapped legacy vaults remain offline recovery data.
Rollback before resumed writes restores the complete backup and compatible application/client state. After writes,
take a fresh backup and reconcile rather than discard new changes. Cutoff needs reviewed required-consumer migration,
a recorded quiet observation interval and explicit action, including named retained DAV/Saber exceptions.

ObsidiSync owns document transport/storage/access/history. Harmony owns household semantics; Marvin owns provisioning,
deployment and backups. Ordinary Markdown and attachments remain portable. External remotes, backups, administrators
and compromised endpoints remain separate trust boundaries; share membership is not encryption.

## Testing and Acceptance

Follow the focused acceptance criteria in FEAT-04 and FEAT-05. Preserve the completed server regression suites,
including every supported protocol, workers, mapped v1, independent credentials and publication recovery.
Use disposable data and synthetic credentials.

Run required Rust, plugin, end-to-end and packaged-command suites for affected integration work. Test authorized and
unauthorized share selection, capability changes/revocation, current/history/binary/metadata isolation, safe old-state
migration, non-mutating read-only sync, and independent mount recovery.

Human fixture acceptance should exercise Andy/Liz private and Harmony synchronization, conflicts/history/binaries,
separate-vault selection, then composite desktop/mobile use and rejected cross-share moves. Confirm private notes
cannot be discovered through either user interface or supported protocol. Report automated evidence separately from
human acceptance, deployment and live verification.

## Non-Goals

Folder ACLs as the primary boundary, enterprise account infrastructure, automatic link rewriting, atomic cross-share
moves, remote erasure of synchronized copies, document-semantic changes, and share-native Saber provisioning.
