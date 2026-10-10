# PLAN-02: Composite Local Vault Synchronization

**Status:** Explicit import remains; FEAT-15 is its server prerequisite
**Owner:** Obsidian plugin
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Remaining implementation:** [FEAT-14](FEAT-14-explicit-cross-mount-import.md)

## Current Context

Composite mounts already provide separate share routing, heads, manifests, guarded writes, conflict/reconciliation
state, move generations/barriers and independent scheduling. Conversion/detachment, mounted history and credentials
are implemented. Preserve these contracts:

- [Composite synchronization](../COMPOSITE_MOUNT_DOWNLOADS.md)
- [Conversion and detachment](../LOCAL_CONVERSION_AND_DETACHMENT.md)
- [Mounted history and credentials](../MOUNT_HISTORY_AND_CREDENTIALS.md)
- [Client share selection](../CLIENT_SHARE_SELECTION.md)
- [Server storage and migration](../SHARE_STORAGE_AND_MIGRATION.md)

## Remaining Work

Implement FEAT-14's explicit copy/import on active mounts, selected attachments, verified recovery copies, durable
progress, current destination acceptance and separately confirmed source deletion. Preserve unchanged links and
the special handling of observed moves, local-only endpoints, read-only endpoints and protected/InkVault paths.
Use existing action tokens, serialized settings saves, adapter guards and share sync journals.

Implement [FEAT-15](FEAT-15-native-sync-conditional-create.md) before FEAT-14. It supplies server-enforced conditional
native destination creation; FEAT-14 retains its collision-safety guarantee and owns client consumption. FEAT-06
remains a separate DAV contract and is not a substitute or hard dependency.

## Validation and Completion

FEAT-14 owns its unit/integration tests and documentation. Exercise two principals with private/shared disposable
shares, selected text/binary attachments, collisions, interrupted intents/disk/network operations, lost responses,
concurrent edits, permission loss and stale bindings/generations. Assert source preservation, exact captured-version
acceptance and independent deletion consent; unaffected mounts and independent grants must remain unchanged.

Run `npm run test:plugin`, `npm run build:plugin`, `npm run test:server` and `npm run test:e2e` in Ubuntu/WSL.
Preserve existing authorization, conversion, history, conflict and credential coverage. Packaging fixtures apply
if packaging/admin contracts change. Automated evidence does not establish human acceptance or live behavior.

Human acceptance should exercise Personal/Harmony imports and failure recovery on disposable desktop/mobile notes,
including link limitations and already-moved sources. Production migration remains separately authorized after
validation, with inventory, approved mappings, protected complete backups and explicit per-mount reconciliation.
No production access, deployment or Marvin/Harmony repository changes are authorized by this plan.

## Boundaries

Keep share authorization/storage isolated. Never weaken server privacy boundaries to simplify composite UX.
No atomic cross-share moves, automatic link rewriting, inaccessible attachment copying, multi-account/server
composition, implicit v1 fallback or remote erasure guarantee. Do not silently reset or retarget existing recovery
state or credentials. Preserve ordinary portable Markdown and attachments.
