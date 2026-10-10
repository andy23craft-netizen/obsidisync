# Composite mount synchronization

The plugin implements FEAT-10's fresh composite setup and scoped downloads and FEAT-11's explicitly writable mounts.
Existing-vault conversion/detachment, composite history/credential management and explicit import remain separate
FEAT-12 through FEAT-14 work. Existing v1 and single selected-share workflows retain their previous behavior.
This describes repository implementation and synthetic automated evidence, not desktop/mobile human acceptance
or production rollout. See [PLAN-02](tickets/PLAN-02-composite-local-vault-synchronization.md).

## Fresh setup

Use a new empty local Obsidian vault with no previous synchronization, history or recovery state. Normal root
`.obsidian` configuration is allowed. A populated vault or retained sync/recovery evidence requires explicit
conversion, which this stage does not provide. Do not clear settings or move files to bypass that check.

1. Configure the server and log in normally. Open Settings -> Composite mounts -> Manage mounts.
2. Enter a nonempty local folder prefix, such as `Personal`, and add the authorized private share by stable ID.
   Add the household share under `Harmony`. All mounts use the same server and verified account; names are labels.
3. For each mount, choose Back up and download and confirm that folder's reconciliation. Selection alone and
   background synchronization do not initialize files. Local files added after selection are included in that
   mount's verified backup before replacement. Edits/deletions after backup are preserved for reconciliation.
4. Once initialized, startup, timer, manual and close synchronization perform download-only reads per mount until
   Enable writes is explicitly confirmed for that mount. Retained edits still require separate reconciliation.
   Manage mounts shows capability, initialization, last attempt/completion, errors, local records and move barriers.
   Retry downloads resumes incomplete initialization or retries an initialized mount independently.
5. Alternatively, an uninitialized read-write mount offers Back up and replace share. Confirm the named share ID
   and folder: this replaces that share with the verified local folder, including remote-only deletions, against
   a real remote base. It enables writes only for that mount. Concurrent changes produce recoverable conflicts.
   An interrupted initial upload cannot repeat replacement: resume recovery/downloads and explicitly reconcile.

Prefixes cannot overlap, alias by case/Unicode normalization, or mount the same share twice. Remote/local file and
folder aliases fail closed rather than overwriting another spelling. Files outside the prefixes remain local-only.
`.git`, `.obsidian`, `.obsidian-git-sync`, `.trash`, history snapshots, caches and plugin settings cannot synchronize
through a mount. Root configuration is not shared. Existing single-share/v1 ignore rules are unchanged.
InkVault sources remain gated and omitted, without inferring deletion; ordinary exported PDFs/attachments work.
Markdown links remain unchanged. Opening a link does not copy its target into another share.

## Preservation and recovery

Each mount owns its destination/identity, capability, per-file baseline, observed head, backup evidence, local
reconciliation, application intent, server conflict records, move generation and status. Share-relative evidence
never becomes a sibling's baseline. Backups stay under the local root at
`.obsidian-git-sync/backups/<unique-id>-<mount-id>/<prefix>/...`; retain plugin settings with recovery copies.

Downloads verify inline/reference checksums and pin blob reads to the returned remote head. Before updating or
deleting a file, the plugin compares actual local bytes with the known baseline or verified initial backup, saves
application intent and checks again before the adapter operation. Interrupted application becomes conservative
local reconciliation. An observed remote head is not proof of synchronized local contents.

Edited, deleted, unreadable or conflicting local files stay blocked while safe files/mounts continue. Downgrade,
restart, re-login and restored write membership do not clear barriers or approve uploads. Authorization denial never
selects legacy v1 as a fallback. Do not hand-edit state to bypass reconciliation. History metadata and credential
management remain unavailable in composite mode.

Writable scans, staged chunks, sync/resolve submissions, baselines and server conflicts use only share-relative
paths within their mount. Exact captured hashes/deletions are saved before staging. Completion never acknowledges
a fresh filesystem scan. Edits during transfer become preservation records; failed/ambiguous staging does not
replay upload IDs. Composite captures also retain their original mount/binding/revision/generation; corrupt or
retargeted evidence fails closed. Before every dispatch, including after token refresh and capability negotiation, the operation
checks its original mount/binding/configuration revision/move generation, capability and affected path barriers.
The same checks protect response acknowledgement and local application.

Local reconciliation offers Keep local (upload blocked), Back up and use remote, and, with explicitly writable
membership, Back up and upload local choice. Remote choice refreshes the current target and verifies a fresh local
backup before replacement/deletion. Upload choice separately captures current bytes or deletion against a fresh
remote base; concurrent changes can still conflict. Server conflicts have a separate per-mount resolver. Text marker
views are checksum verified inline contents, never blobs inferred from the returned Git head. Binary choices retain
their original bytes; the missing-file restore choice fetches checksum-verified current committed bytes.

## Detected moves

The plugin observes Obsidian rename events after local mutation. A detected cross-mount move, move into/out of
local-only space, folder move or mount-root rename advances affected mount generations and records persistent
barriers for both endpoints. In-flight actions with old generations cannot apply or acknowledge downloaded bytes.
Affected paths stay blocked; unrelated mounts can continue. A missing mount folder never approves mass deletion.
Move barriers remain after restart and successful reads. A request dispatched before a move may already have
committed. Stale callbacks cannot acknowledge it; original staged/submitted/accepted captures remain recoverable.
Fresh authorized snapshots and server conflict reads establish only an exact captured version's outcome. Divergence
retains captured hash/deletion and phase evidence in local reconciliation. Recovery never clears move barriers.

Manage mounts shows both move endpoints and offers a separately confirmed decision for one endpoint only. Keep local
saves local upload barriers before releasing that endpoint's move barrier; it grants no upload/deletion consent.
Back up and use remote restores the selected endpoint after a fresh target read and verified backup. Back up and
upload endpoint explicitly approves current contents, including local deletions, for that endpoint only. Conflicts,
new edits, another covering move barrier or uncertain outcomes retain the move barrier. Overlapping move barriers
can first use Keep local to retain preservation records. The other endpoint remains blocked until its own decision.
This is reconciliation of an already detected move, not the FEAT-14 copy/import workflow.

If saving a move barrier fails, affected mounts stop in memory and show a persistence error. Retry synchronization
after fixing storage to save retained evidence before more work. Preserve settings/recovery copies and the moved
files; do not restart merely to bypass the error. A failed persistence operation cannot promise durable evidence
across an immediate process loss. No automatic filesystem undo, remote deletion or credential change occurs.

External changes made while the plugin is stopped cannot reliably be identified as moves. Obsidian's adapter has
no cross-process compare-and-swap: final checks protect detected edits, not arbitrary concurrent external writers.
Client routing is not an authorization boundary against deliberate copying or compromised endpoints. Server share
membership/storage isolation remains authoritative, and previously synchronized copies cannot be remotely erased.

## Validation boundary

Automated fixtures exercise independent mounts, protected/alias paths, verified backups, byte/checksum preservation,
interrupted application, identity/configuration changes, capability loss/restoration, persisted move barriers and
sibling retries. The real-server composite scenario uses two synthetic principals with separate private shares
and a shared share; it checks inaccessible discovery/content/blob/history responses and unchanged share storage
fingerprints after downloads. Writable fixtures cover original-token checks at every dispatch stage, staged/committed
moves, lost responses, restart, permission restoration, initial activation failures and explicit endpoint release.
The real-server writable scenario covers three mounts, text/binary conflicts, edit/delete conflicts, partial staging,
committed-but-stale responses, membership changes, concurrent initial replacement and inaccessible reads/mutations.
Existing legacy/writable/history/credential and server authorization regressions remain.

Ubuntu/WSL automated results on 2026-10-10: `npm run test:plugin` passed 194 tests; `npm run build:plugin` passed;
`npm run test:server` passed 145 tests with one existing ignored sample-PDF test; `npm run test:e2e` passed all seven
scenarios. The first Rust run hit an existing conflict test's filesystem error; that test passed in isolation and
the full Rust rerun passed. Tests use disposable synthetic data, not household documents or deployed services.

No server migration is required for this client feature. Install the updated plugin through the normal operator
workflow. A previous download-only composite build rejects writable/journal state; do not reset that state to
force a downgrade. Preserve settings and recovery copies and reconcile uncertain contents before changing clients.

Human desktop/iPhone acceptance remains required: use disposable notes/attachments to inspect setup/status,
initial upload/enable writes, per-mount conflict/reconciliation, offline edits, permission loss, interruptions and
detected moves. No production migration, deployment, household
data access or sibling repository changes are performed by this stage.
