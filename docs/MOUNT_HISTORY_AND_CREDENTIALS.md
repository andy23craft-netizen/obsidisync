# Mount history and credentials

FEAT-13 adds composite history, local snapshots and explicit mount-scoped credential management. These are
repository features validated with synthetic fixtures; desktop/mobile human acceptance and live deployment remain
operator work. See [composite synchronization](COMPOSITE_MOUNT_DOWNLOADS.md) for initialization and recovery.

## History and restoration

Open the history sidebar for a file inside a configured mount. The sidebar identifies its prefix and share ID.
History, historical content, binary blobs, device versions and version metadata use that mount's captured stable
identity and share-relative path. Equal filenames in Personal and Harmony do not share remote history or snapshots.
Files outside mounts are local-only and cause no remote history requests. Denied share requests never fall back to v1.

Historical content is pinned to its revision and verified against its checksum. Renaming, detaching or changing the
captured destination invalidates stale actions. Version naming/squashing requires current write membership and an
explicitly writable mount; download-only mounts cannot mutate history metadata. Existing recovery/move gates apply.

Opened historical copies live under root `ObsidiSync History`, excluded from all shares. Snapshot references retain
mount ID, destination binding, share ID, original local source path and revision. Reuse requires matching ownership
and actual bytes. An edited copy, sibling collision or unbound old copy gets a separate filename, never an overwrite.
Old unbound snapshots remain local evidence; the plugin does not guess their composite owner. Detached or otherwise
unavailable ownership cannot resolve a snapshot into another mount's history.

For a selected-share historical entry, **Restore locally with backup** confirms the destination and revision. It
verifies a backup of current local bytes, durably records application intent and upload-blocked reconciliation, then
applies the verified historical bytes only if the local file still matches the captured state. Recover pending
initialization/application/write work first. A move barrier prevents restoration. Restoration does not upload, enable
writes, advance the synchronized baseline or clear existing reconciliation. Resolve the owning mount's reconciliation
explicitly before upload. Failed/interrupted application retains recovery evidence. Keep backups and plugin settings.

## Two independent credential inventories

Open **Device passwords** while logged in. Composite mode requires choosing a mount explicitly for share-native
grants. Changing mounts, account/configuration or mount lifecycle invalidates captured actions. A grant request does
not initialize file synchronization, authorize uploads or clear recovery state.

Share-native inventory shows share ID, folder scope, capability and lifecycle. Read membership can issue a read grant;
read-write issuance and revocation require write membership. If management is unavailable, ask the host operator to
inventory/revoke grants offline. Share ID is the Basic/OCS username; the creation result supplies DAV and Nextcloud
URLs. Newly issued grants are staged: offline `credential share activate ID` activates the existing grant without
rotation. Selection, initialization and restart do not activate it. Native grants do not enable Saber processing.

Legacy DAV/Saber inventory remains bound to its retained original server/user/vault namespace, independently of the
selected mount. Missing original context is not reconstructed from current settings. Only the exact inventory header
`X-ObsidiSync-Legacy-Grant-Management: allowed` enables creation/revocation; missing, unknown or denied values keep
inventory visible while disabling mutations. Service mutations recheck this authority. Existing legacy passwords,
URLs and Saber settings are retained. Historical Saber exports can scan the original mapped vault beyond their DAV
folder scope; that behavior cannot cross into another share.

One-time secrets are held only by the open dialog, never saved to plugin settings, and cleared when switching mounts
or closing. If creation's response is lost, inspect inventory before issuing another grant; there is no automatic
creation retry and the secret cannot be recovered. Close and reopen stale dialogs after login/configuration changes.

Active grants are independent of their creator's later membership. Detachment or loss of native membership does not
revoke an active DAV grant. Revoke it separately through authorized management or the offline host operator; share
retirement also denies access. Previously synchronized local copies cannot be remotely erased with a security
guarantee. Share membership does not protect data from administrators, backups or compromised endpoints.

## Validation and remaining acceptance

Plugin tests cover ownership/checksums, edited snapshots, guarded restoration, stale actions, capability/header
matrices, independent grants and one-time-secret handling. The real-server `scenario-mount-history.js` uses identical
relative filenames in separate shares, historical text/binary reads, isolated metadata, backup/reconciliation,
independent grants, membership loss and denied routes without v1 file fallback. It verifies an activated DAV grant
survives creator membership removal and that sibling state is unchanged.

Human acceptance should exercise sidebar opening/restoration and grant selection/copy/close on supported desktop
and mobile using disposable notes. No live grants, migration, deployment or third-party client verification was
performed. Explicit cross-mount import remains FEAT-14 work.

Local Ubuntu/WSL checks on 2026-10-10:

- `npm run test:plugin`: 237 passed, zero failed, including an edit after historical backup with durable recovery.
- `npm run build:plugin`: passed; tracked `main.js` regenerated.
- `npm run test:server`: 145 passed, one ignored, zero failed.
- `npm run test:e2e`: all nine scenarios passed, including FEAT-13's four-stage real-server scenario.
- `git diff --check`: passed.
