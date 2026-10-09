# FEAT-04 implementation decomposition

The [FEAT-04 contract](FEAT-04-client-share-selection-and-migration.md) remains authoritative and unchanged.
Implemented FEAT-04A/B and the two remaining tickets collectively implement it; none independently completes
FEAT-04 or authorizes deployment. Existing server interfaces are prerequisites, not new implementation work.

## Tickets and dependencies

| Ticket | Behavioral outcome | Hard dependency |
| --- | --- | --- |
| [Implemented FEAT-04A](../CLIENT_SHARE_SELECTION.md) | Discover/select a share without silently retargeting existing state | Implemented server |
| [Implemented FEAT-04B](../CLIENT_SHARE_SELECTION.md) | Safely download and preserve edits through read-only transitions | FEAT-04A |
| [FEAT-04C](FEAT-04C-writable-share-sync-and-conflict-workflows.md) | Complete writable v2 synchronization and server conflict workflows | FEAT-04A, FEAT-04B |
| [FEAT-04D](FEAT-04D-legacy-and-share-credential-management.md) | Manage legacy and share-native grants with distinct authorization/lifecycles | FEAT-04A |

Recommended remaining review order is C -> D. D only requires implemented A; C ordering before D is a convenience.
FEAT-05 requires all four and the parent acceptance audit, not merely C's working upload path.

## Coverage and ownership

| Parent requirement | Owner |
| --- | --- |
| Share discovery, stable ID, labels, capability negotiation, API feature gating | A |
| Server/share-bound state, retained old configuration and separate legacy namespace context | A |
| Authentication continuity, OIDC re-login, explicit development identity, no denial fallback | A |
| Safe download migration, backup-before-overwrite, restart-safe initial download | B |
| Read-only reads/history/references, safe per-file application and uncertain-state handling | B |
| Durable local conflicts, truthful baselines, remote advancement and interrupted apply | B |
| Downgrade preservation, local-only reconciliation and explicit re-upgrade barrier | B |
| Uploads/write sync, force-push reconciliation, retry and binary transfers | C |
| Server conflicts/resolve, InkVault, device/version metadata and writable history actions | C |
| Applying B's safety/barriers to writes and distinguishing 403 capability errors | C |
| Legacy v1 credential management, authorization loss/cutoff, Saber continuity | D |
| Staged/active share grants, capability-aware issuance, URLs and independent revocation | D |
| Regression tests, user documentation and manual criteria | Each ticket for its own behavior |
| Whole-feature required suites and final parent acceptance coverage | C/D, whichever finishes last |

A owns identity and destination selection, B owns per-file application/reconciliation state, C owns write
acknowledgements and server conflicts, and D owns credential workflows. Extend these responsibilities rather than
creating separate endpoint/state special cases in each ticket. Do not duplicate server conflict records as local
preservation records.

## Coherent intermediate states

A provides discovery, persisted selection and explicit migration-pending state; it must not activate incomplete v2
file synchronization or let scheduled v1 sync silently use pending v2 configuration. Old unconverted configurations
retain their intentional v1 behavior. B enables safe download reconciliation; v2 uploads remain unavailable until C.
C enables writable workflows using B's preservation barriers. Until D, a selected v2 destination must not silently
route legacy device UI through v2 or offer legacy credentials as share-native grants.

These are implementation sequencing boundaries, not alternative final product contracts. All parent workflows must
work when FEAT-04 is complete. No partial stage is approved for household production deployment.

## Completion and scope

Each ticket owns tests and documentation alongside behavior. Use disposable data and synthetic credentials.
Run focused checks per ticket and the required Rust/plugin/end-to-end/packaged suites before declaring FEAT-04
complete; the final implementer reviews every parent acceptance criterion, including integration across all four.
Human desktop/mobile acceptance is separate from automated evidence.

No new product decisions block this decomposition. Exact state schemas/helper boundaries remain engineering choices.
Keep one selected share per local vault. No FEAT-05 mounts, server redesign, new authentication features,
Marvin/Harmony changes, production access, migration, deployment or ARM64 production image publication.
