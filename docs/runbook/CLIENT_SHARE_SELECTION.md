# Client share selection and safe synchronization

The plugin implements destination-bound selection (FEAT-04A), safe downloads (FEAT-04B) and writable share workflows
(FEAT-04C) with separate legacy/share credential management (FEAT-04D). Download initialization starts download-only,
even with read-write membership. Enable writes explicitly enables synchronization for reconciled files.
Unconverted configurations retain v1 behavior.
Fresh empty vaults also support [scoped composite synchronization](COMPOSITE_MOUNT_DOWNLOADS.md) (FEAT-10/11),
with independently enabled writes, initial upload, conflicts and explicit move endpoint reconciliation.
The single-share instructions below remain applicable to existing installations; they do not convert a vault.
This is implemented repository behavior, not a household deployment or desktop/mobile acceptance result.

## Selecting and initializing

In settings, choose Server share selection -> Choose share. Discovery uses the advertised `shareSyncV2` feature,
not the API version number. Only authorized, published shares returned by the server can be selected. A label is
display information, never an alias or authorization. Selection alone never changes files or legacy sync state.

Reopen the chooser and choose Back up and download share. Confirm the explicit initial reconciliation:

1. Copy supported local files into a fresh `.obsidian-git-sync/backups/<timestamp>-<id>/` folder and verify every
   copied file's checksum. A failed backup permits no file application; retries create a new folder and keep the old
   copy. Plugin recovery/history and gated InkVault source paths are excluded from replacement.
2. Read the share snapshot. Before each update/deletion, compare local bytes with the actual backed-up bytes.
   An edit or local deletion after backup is preserved for reconciliation. Previously absent paths can be downloaded
   only while still absent. No uninitialized background sync can select overwrite-local on the user's behalf.
3. Save an application intent before each disk operation, recheck local state immediately before application, then
   acknowledge only that successfully applied file. Interrupted disk operations become conservative local records
   on resume. Resume initial download in the chooser; successfully applied files need not be overwritten again.
4. When the snapshot is processed, activate download-only mode. Files blocked by local changes stay blocked and
   visible; other files can complete. Original v1 settings, heads, manifests and recovery/history records are retained.

Cancel pending selection returns to v1 only before initial download starts and only with the original binding intact.
After recovery starts, cancellation/retargeting is unavailable because it cannot safely restore the original files.
Resume the download instead. Use a separate local Obsidian vault to select another share at this stage.
Returning to a pre-reconciliation installation requires an intentional offline restoration of its matching local
backup **and plugin settings**, not merely clearing selection fields or resuming v1 on mixed contents.

## Ordinary download synchronization

In download-only mode or with read-only capability, startup, timer, manual and close synchronization use the
selected-share download path. It verifies
the selected identity/configuration, negotiates current capability and sends `POST /v2/shares/{id}/sync` with
`changes: []`, `baseHead: null` and an empty client manifest. It never registers, uploads, resolves server conflicts,
refreshes upstream or writes document/version/device metadata to download. Normal authentication refresh may still
renew a session. Authorization denial never falls back to v1.

Full read snapshots intentionally trade some manifest traffic for straightforward recovery: current remote targets
remain reachable after head advancement or interruption. Matching local/remote content avoids another blob download.
Reference and inline bytes are checksum-verified. Blob requests pin the returned remote head; authorized history,
device-version reads and historical file downloads use v2 too. Historical content is checksum-verified.
This client continues not to advertise `inkVaultNotesV1`; gated `.inkvault/` source omission never means deletion.
Ordinary exported PDFs remain supported. Managed InkVault PDFs cannot be independently changed by ordinary clients:
rejection retains local bytes and recovery creates a barrier. Native InkVault clients retain their separate
feature-gated paired source/PDF publication and resolution protocol. This plugin does not provision source editing.

Each file has its own synchronized baseline. Local edits, new local files, local deletions, unreadable paths or
file/folder mismatches fail closed for that file. Unaffected files continue. A remote update/deletion can apply only
when current local bytes still match the baseline, including a second check after network work and journal saving.
No completion-time vault scan acknowledges edits that were never sent or applied.

## Local reconciliation and permission changes

Settings and synchronization notices show capability, selected mode and pending counts. Open conflict resolver to
review **local reconciliation** records, separate from server merge conflicts. The file history view marks affected
files as reconciliation-required. Mutable metadata actions require writable mode and read-write capability,
rechecked before submission. The mobile changed indicator includes barriers.

- Keep local (upload blocked) records an explicit local choice, retains bytes/deletion and keeps the upload barrier.
- Back up and use remote requires confirmation, refreshes the current remote target, verifies a fresh local backup,
  and rechecks local bytes before applying that target/deletion. An intervening edit stays blocked. The backed-up
  edit is retained; this action never submits an upload or server resolution.

A record retains path, original baseline, latest observed remote hash/deletion and head, reason, optional local choice
and backup folder, and `uploadBlocked: true`. Remote advancement updates the target without changing its baseline.
Disk application has a separate saved `applying` intent. Restart never guesses that an ambiguous disk operation
succeeded merely because bytes happen to match a remote hash.

Observed read-only capability is saved. Local edits are scanned into barriers before the following read request,
so a failed read does not lose downgrade protection. Restart, re-login or restored read-write membership cannot
clear these barriers or make retained edits uploadable. Even Keep local requires separate explicit write
reconciliation before any upload. Read-only users see no server-mutating conflict, metadata or upload actions.

## Persisted ownership and C integration

- `legacyManagementContext` keeps original server/userSlug/vaultSlug. Login does not rewrite it. D will expose its
  independently authorized management routes; B continues blocking the old credential UI for selected shares.
- `legacySyncBinding` binds legacy baseline reuse to its original server/namespaces and known session subject.
- `authenticatedIdentity` is the server-returned session context for local state ownership, never a share grant.
  Manual token changes invalidate it; Server Check verifies the new session. The authentication configuration marker
  never reconstructs an OIDC issuer or resolves membership. Issuer-less sessions still require fresh verified login.
  Development tokens still require explicit server enablement, membership and mapping; production modes reject them.
- `pendingShareSelection.download` contains initial backup/recovery progress. `activeShare.download` owns the selected
  share's `baseline`, `observedHead`, local `reconciliation`, `applying` intent, initial recovery evidence,
  `writing` journal and separate `serverConflicts`.
  The flat legacy `serverHead`/`localManifest` are never repurposed as a share baseline.

These fields use Obsidian's plugin data persistence; the vault adapter and plugin settings are not one transaction.
Plugin saves are serialized with captured snapshots so overlapping UI/history/login saves cannot persist out of order.
Intent-before-write and conservative recovery handle the disk/state interruption boundary. Keep plugin settings with a local
recovery backup. Do not hand-edit/delete state to bypass barriers. The adapter offers no cross-process compare-and-swap;
final checks protect edits detected before the adapter operation, not concurrent external filesystem writers.

Writable sync consumes guarded application and per-file state, recovers application/write journals before collecting
uploads, and excludes every upload barrier until explicit reconciliation. Observed head advancement never
acknowledges local bytes. Every write stage rechecks capability.

## Automated evidence and remaining validation

Synthetic fixtures cover mixed safe/edited files, local/remote deletions, changes during transfer, checksum failures,
backup failure/resume, ambiguous disk interruption, remote advancement, downgrade/restart/restoration, local choices,
identity/configuration changes, denied access without fallback and retained legacy state. The e2e harness runs writable v1, read-only v2 and writable v2 recovery/conflict scenarios. Read-only tests check
share storage fingerprints for mutation. Native InkVault v2 publication/feature/capability gates and ordinary plugin
PDF compatibility are exercised separately.

Human desktop/iPhone acceptance remains separate from automated validation. Existing v1 application semantics are
preserved; guarded primitives apply to selected
shares. Full snapshots and per-file state saves favor safety over transfer/storage efficiency. No production access,
migration, deployment, sibling repository changes or ARM64 production publication is authorized by this stage.
See the credential workflow below and
[server publication/migration contracts](SHARE_STORAGE_AND_MIGRATION.md).

## Writable workflows and interruption recovery (FEAT-04C)

Enable writes explicitly opts a downloaded vault into uploads after recovery and capability checks. Existing local
records remain blocked. Alternatively, before initial recovery starts, Back up and upload local vault confirms
replacement of the selected share, including remote-only deletions. A fresh verified backup is mandatory. The client
reads the actual remote snapshot/base and captures checked local bytes before staging. Concurrent remote changes
can conflict. No v1 registration, baseline reuse or label mapping occurs. Preparation failures leave pending recovery:
resume safe download reconciliation with retained local backups. Submission failures retain active state and a journal.

Writable synchronization captures bytes and hashes together, saves a write journal, stages chunks and submits changes.
Capability is checked before initialization, every chunk, completion, sync, server resolution and mutable metadata.
Observed downgrade or HTTP 403 stops subsequent writes and saves preservation barriers. The server remains authoritative
during requests. Only successfully accepted captured contents advance baselines. The following full snapshot applies
merged contents against that exact evidence; edits during transfer remain local and become barriers.

Server merge conflicts are persisted separately. Inline marker bytes are a conflict view, not contents at the returned
Git head: verify checksums, back up local bytes and guard application without acknowledging markers. Binary conflicts
preserve local bytes. The local reconciliation window offers a separate server resolver in writable mode. Explicit
choices back up local files and use v2 resolve; pending paths are rechecked after resolution and restart.

Back up and upload local choice is a separate explicit action for local barriers, available only in writable mode.
It refreshes the remote target, captures/backups current bytes or deletion, and submits against that refreshed base.
Concurrent remote changes can still conflict. Server-conflicted paths require the server resolver. Keep local alone
never approves an upload. Historical reads, device listings/versions and mutable version metadata use v2.

The write journal stores exact per-file hash/deletion evidence before network mutation:

- Staging: submission was not confirmed; recovery blocks captured edits rather than auto-uploading them.
- Submitted: a response may be lost. Authorized reads compare remote contents with captured evidence and pending
  conflicts. Exact matches may acknowledge only the captured version; divergence/conflicts require reconciliation.
- Accepted: success was received; the journal survives interruption while saving baselines. Recovery remains
  conservative if remote contents subsequently diverged.

Newer local edits remain detectable after matching acknowledgement recovery. Consumed upload IDs are never blindly
replayed. Partial staging can leave temporary server uploads until normal cleanup; persisted byte-offset continuation
is not promised. Safe downloads/matching acknowledgements recover automatically; ambiguous writes require review.
The documented non-atomic external-writer filesystem race remains. No storage-adapter redesign is included.

## Credential management

The device-password dialog shows two independently authorized inventories. Legacy DAV/Saber uses retained
`legacyManagementContext` (server/user/vault), never the selected share ID or label. Missing context after selection
is not reconstructed. Namespace mismatch, membership loss or native cutoff keeps the context but explains why
management is unavailable. Credential requests are a narrow exception to the v1 destination guard; registration,
sync, uploads, history and other legacy file requests remain guarded.

Successful v1 inventory responses include `X-ObsidiSync-Legacy-Grant-Management: allowed|denied` using the original
mapping/namespace write authorization. Only `allowed` enables create/revoke controls. Missing/unknown headers on older
servers leave authorized inventory visible without management controls. Selected-share capability cannot override it.
Supported CORS configurations expose the header. It does not authorize mutations; the server rechecks every operation.

Share-native inventory uses the selected stable ID, with fresh session/configuration/capability negotiation.
Read grants explicitly request `read`; read-only members cannot revoke through this API and need host-operator help.
The modal displays staged/active lifecycle and one-time create secrets, correct share-ID Basic/OCS identity, and DAV
and Nextcloud URLs. Secrets are not saved in plugin state or recovered from inventory. Closing clears the modal.
Lost creation responses require inventory review before intentional reissue; network failures never auto-retry creation.
Offline `admin --data-dir /data credential share activate ID` activates an existing grant without rotation.

Active grants remain independently usable after creator membership removal/disable/downgrade until explicit
revocation or share retirement. Session management can become unavailable before the grant stops working; use offline
operator inventory/revocation. Existing legacy Saber identities, URLs, encryption/PDF configuration and permissions
are preserved. Historical vault-wide #tablet scanning remains inside the original mapped share and can exceed the DAV
folder restriction. New share grants do not enable Saber scanning/rendering/pushing; share-native provisioning is deferred.

Credential actions neither approve blocked file edits nor bypass initial reconciliation, interrupted application or
write journals. Account/destination changes invalidate an open modal's actions. File sync still performs its normal
recovery and capability checks afterward.

## FEAT-04 parent acceptance audit

Implementation coverage is complete across A/B/C/D. This is an audit of repository code and synthetic automated
evidence, not human acceptance or production verification.

| Contract | Implementation and automated evidence |
| --- | --- |
| Stable authorized selection, one share per local vault, retained v1 state | `shareSelection.ts`, `GitService`, chooser/settings; `shareSelection.test.ts`, Rust protocol authorization matrix |
| Read-only reads without registration, per-file preservation and truthful baselines | `ShareReconciler`, `VaultState`; `shareDownloads.test.ts`, read-only e2e storage fingerprints |
| Downgrade/restart/restoration, durable application and upload barriers | Reconciliation/application/write journals; plugin interruption tests and actual membership-change e2e |
| Explicit initial backup/reconciliation and writable v2 without fallback | Initial/selection UI, v2 upload/resolve/history routes; writable e2e and base-revision regressions |
| Conflicts, binary/reference transfers, history/device metadata and InkVault | Plugin regression tests, Rust protocol/InkVault suites, writable and legacy e2e scenarios |
| Independent legacy/share grants, staging/activation, header/CORS and revocation | Credential modal/service, legacy inventory handler; plugin capability matrix, Rust header/transition tests, credential e2e |
| Legacy Saber settings/rendering/background security continuity | Untouched legacy grant records through selection; synthetic credential e2e and published legacy Saber Rust regressions |
| OIDC identity exception, explicit development identity, publication/recovery | Existing authentication/transition suites and packaged-command fixtures, including production-default development rejection |

The final local validation passes 151 plugin tests and the plugin build, 145 Rust tests, strict all-target Clippy,
five real-server e2e scenarios and actual Dockerfile AMD64 packaged-command tests. The only ignored Rust test writes a sample PDF
for human inspection; automated Saber rendering tests run normally. Expected authorization failures in negative
fixtures are assertions, not unresolved test failures. No production or sibling repository data is used.

Remaining acceptance is a human desktop/iPhone pass using disposable notes: separately selected private/shared
vaults, offline edits, overlapping updates/deletions, permission loss/restoration, interruption/restart, history,
attachments and the two credential sections. Supported CORS behavior is router-tested; actual Obsidian mobile UI
and third-party DAV clients have not been exercised here. Keep the documented external-writer filesystem race,
conservative ambiguous-write reconciliation and non-resumable partial upload staging in mind.

FEAT-04 is ready for final human acceptance review. [Composite synchronization](COMPOSITE_MOUNT_DOWNLOADS.md)
describes the implemented composite initiative. FEAT-10/11 fresh mount downloads and writable synchronization and
[FEAT-12 conversion/detachment](LOCAL_CONVERSION_AND_DETACHMENT.md) and
[FEAT-13 mount history/credentials](MOUNT_HISTORY_AND_CREDENTIALS.md) and
[FEAT-14 cross-mount import](CROSS_MOUNT_IMPORT.md) are implemented;
household deployment and coordinated production migration remain later, separately authorized operations.
