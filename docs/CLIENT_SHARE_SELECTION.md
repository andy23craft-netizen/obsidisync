# Client share selection and safe downloads

The plugin implements destination-bound selection (FEAT-04A) and safe download reconciliation (FEAT-04B).
Selected shares are **download-only**, even with read-write membership. FEAT-04C supplies writable workflows;
FEAT-04D supplies separate legacy/share credential management. Unconverted configurations retain v1 behavior.
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

Startup, timer, manual and close-triggered synchronization use the same selected-share download path. It verifies
the selected identity/configuration, negotiates current capability and sends `POST /v2/shares/{id}/sync` with
`changes: []`, `baseHead: null` and an empty client manifest. It never registers, uploads, resolves server conflicts,
refreshes upstream or writes document/version/device metadata to download. Normal authentication refresh may still
renew a session. Authorization denial never falls back to v1.

Full read snapshots intentionally trade some manifest traffic for straightforward recovery: current remote targets
remain reachable after head advancement or interruption. Matching local/remote content avoids another blob download.
Reference and inline bytes are checksum-verified. Blob requests pin the returned remote head; authorized history,
device-version reads and historical file downloads use v2 too. Historical content is checksum-verified.
This client continues not to advertise `inkVaultNotesV1`; gated `.inkvault/` source omission never means deletion.
Ordinary exported PDFs remain supported. Native InkVault write/conflict workflows remain C's responsibility.

Each file has its own synchronized baseline. Local edits, new local files, local deletions, unreadable paths or
file/folder mismatches fail closed for that file. Unaffected files continue. A remote update/deletion can apply only
when current local bytes still match the baseline, including a second check after network work and journal saving.
No completion-time vault scan acknowledges edits that were never sent or applied.

## Local reconciliation and permission changes

Settings and download notices show capability, download-only status and pending counts. Open conflict resolver to
review **local reconciliation** records, separate from server merge conflicts. The file history view marks affected
files as reconciliation-required and hides mutable metadata actions. The mobile changed indicator includes barriers.

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
clear these barriers or make retained edits uploadable. Even local choices require C's explicit write reconciliation
before any future upload. B itself permits no selected-share writes for either capability.

## Persisted ownership and C integration

- `legacyManagementContext` keeps original server/userSlug/vaultSlug. Login does not rewrite it. D will expose its
  independently authorized management routes; B continues blocking the old credential UI for selected shares.
- `legacySyncBinding` binds legacy baseline reuse to its original server/namespaces and known session subject.
- `authenticatedIdentity` is the server-returned session context for local state ownership, never a share grant.
  Manual token changes invalidate it; Server Check verifies the new session. The authentication configuration marker
  never reconstructs an OIDC issuer or resolves membership. Issuer-less sessions still require fresh verified login.
  Development tokens still require explicit server enablement, membership and mapping; production modes reject them.
- `pendingShareSelection.download` contains initial backup/recovery progress. `activeShare.download` owns the selected
  share's `baseline`, `observedHead`, local `reconciliation`, `applying` intent and initial recovery evidence.
  The flat legacy `serverHead`/`localManifest` are never repurposed as a share baseline.

These fields use Obsidian's plugin data persistence; the vault adapter and plugin settings are not one transaction.
Plugin saves are serialized with captured snapshots so overlapping UI/history/login saves cannot persist out of order.
Intent-before-write and conservative recovery handle the disk/state interruption boundary. Keep plugin settings with a local
recovery backup. Do not hand-edit/delete state to bypass barriers. The adapter offers no cross-process compare-and-swap;
final checks protect edits detected before the adapter operation, not concurrent external filesystem writers.

C can consume `VaultState.applyGuarded`, verified byte/backup helpers and the per-file state directly. It must
acknowledge only sent/applied content, recover `applying` before new work, and exclude every `uploadBlocked` path
until explicit write reconciliation. `observedHead` is observation, not evidence that all local files are synchronized.
Keep local preservation records distinct from server conflicts and check current capability before every write stage.

## Automated evidence and remaining validation

Synthetic fixtures cover mixed safe/edited files, local/remote deletions, changes during transfer, checksum failures,
backup failure/resume, ambiguous disk interruption, remote advancement, downgrade/restart/restoration, local choices,
identity/configuration changes, denied access without fallback and retained legacy state. The e2e harness runs both
writable v1 conflicts and real read-only v2 downloads, checking share storage fingerprints for document mutation.

Human desktop/iPhone acceptance, native InkVault workflows and writable share/credential UI acceptance remain for
C/D and the parent audit. Existing v1 application semantics are preserved; B's guarded primitives apply to selected
shares. Full snapshots and per-file state saves favor safety over transfer/storage efficiency. No production access,
migration, deployment, sibling repository changes or ARM64 production publication is authorized by this stage.
See the [FEAT-04 decomposition](tickets/FEAT-04-DECOMPOSITION.md) and
[server publication/migration contracts](SHARE_STORAGE_AND_MIGRATION.md).
