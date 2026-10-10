# FEAT-01: Multi-User Shares and Composite Vault Sync

**Status:** Explicit cross-mount import remains
**Owner:** Obsidian plugin
**Remaining plan:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)
**Implementation ticket:** [FEAT-14](FEAT-14-explicit-cross-mount-import.md)

## Current Context

The server implements accounts, typed principals, share membership, published isolated share storage, v2 APIs,
scoped DAV grants and offline migration/recovery. See [server contracts](../SHARE_STORAGE_AND_MIGRATION.md) and
the [server implementation audit](../SERVER_IMPLEMENTATION_AUDIT.md).

The plugin implements independently authorized Personal/Harmony mounts, guarded synchronization, conversion,
detachment, mounted history and independent credentials. See [composite synchronization](../COMPOSITE_MOUNT_DOWNLOADS.md),
[conversion/detachment](../LOCAL_CONVERSION_AND_DETACHMENT.md) and
[history/credentials](../MOUNT_HISTORY_AND_CREDENTIALS.md).

## Remaining Implementation

Deliver explicit cross-mount copy/import with verified destination acceptance before separately confirmed source
deletion, as specified by FEAT-14, using the implemented [native conditional creation API](../../README.md#api).
Preserve recoverable copies after partial failure, unchanged Markdown links, explicit attachment selection and independent
mount recovery. Links grant no access and must not trigger copying inaccessible content.

Keep private and shared content/history isolated by opaque share identity. Never infer authorization from labels
or local folders. Preserve issuer-bound identity, intentional mapped v1 compatibility, independent device/service
grants, legacy Saber behavior and staged credential activation. No migration, credential retargeting, fallback or
client state reset may occur implicitly.

## Validation and Operator Boundaries

Follow PLAN-02 and FEAT-14's automated and human validation criteria using disposable data and synthetic credentials.
Human desktop/mobile acceptance and live verification remain separate from implementation evidence.

Production rollout requires separately authorized inventory, approved mappings, protected complete backups,
dry-run/collision checks, coordinated publication and explicit client reconciliation. Before resumed writes,
rollback restores the complete backup and compatible application state; afterward, take a fresh backup and
reconcile newer data. Never discard newer documents or silently reissue credentials.

ObsidiSync owns document transport/storage/access/history; Harmony owns household semantics; Marvin owns host
provisioning, deployment and backups. No sibling repository changes or production access are authorized here.
Share membership does not protect against administrators, backups, external remotes or compromised endpoints,
and cannot securely erase previously synchronized local copies.
