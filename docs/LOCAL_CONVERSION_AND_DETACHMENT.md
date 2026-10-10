# Local conversion and detachment

FEAT-12 implements local vault conversion and inaccessible-binding detachment. This describes repository behavior
and disposable automated fixtures, not a production migration or desktop/mobile human acceptance result.
See [composite synchronization](COMPOSITE_MOUNT_DOWNLOADS.md) for subsequent initialization and write consent.

## Convert an existing vault

1. Stop external editors/sync tools and preserve an independent copy of the vault and plugin settings. Log in to
   the destination server. Recover original selected-share initialization, application/write journals and conflicts
   first. If original access is unavailable, explicitly detach it as described below; conversion cannot transfer
   its unresolved work or permissions. V1 notes, history and settings evidence are retained.
2. Open Settings -> Conversion and detachment -> Conversion and recovery. Available shares show their stable IDs.
   Choose target shares from the selector and enter nonoverlapping local prefixes, such as `Personal`.
   Add target rows for additional shares. Enter explicit source/destination file mappings, including attachments:
   `note.md` -> `Personal/note.md`. Add one mapping row per file. Leave unused rows empty.
   Add every intended file; this is an explicit file mapping tool, not automatic folder discovery or link rewriting.
   Root `.obsidian` configuration, recovery/history paths, unsupported sources and symlinks cannot be relocated.
   Unmapped files are retained. Files outside all mounted prefixes remain local-only; retained files already inside
   a newly selected prefix require its subsequent initial reconciliation. Existing active mount sources must first
   be detached. All active siblings retain their identity, state and prefixes.
3. Choose Preview. Review the original binding, stable target IDs and labels, prefixes, per-file bytes/hashes,
   destination absence, excluded files and backup requirements. Resolve collisions outside the conversion workflow
   and preview again. A changed configuration or source invalidates the approval. Choosing a shared destination
   makes those bytes eligible for later sharing after separate reconciliation/upload approval; labels are not ACLs.
4. Confirm Back up, relocate and activate. The plugin stops new engine work, invalidates old callbacks and drains
   dispatched work. A dispatched write may have committed remotely; unresolved original work must be recovered or
   detached. It verifies file backups and an exact credential-bearing settings copy under a fresh
   `.obsidian-git-sync/backups/conversion-<id>/` directory before saving the conversion gate and complete journal.
5. Relocation copies, verifies, then removes only unchanged sources. A durable intent precedes each copy/remove
   substep. Actual disk hashes determine recovery even when progress says a file completed. The plugin verifies
   all mappings and captured excluded files before the ready-to-activate save.
6. One complete settings save activates the composite configuration and marks the journal activated, with a matching
   revision. New mounts have new IDs, empty baselines, no inherited write journals, and uninitialized download-only
   status. Open Manage mounts and authorize initial download or initial replacement separately for each mount.
   Relocation hashes never acknowledge server synchronization or approve uploads. Existing siblings keep their state.

Settings and file backups contain private notes and potentially usable credentials. Keep `.obsidian-git-sync`
local-only and protect exported backups. Conversion never uploads backups, creates server shares, migrates server
storage, changes membership, revokes credentials, or deletes remote files. Old v1/single-share state remains evidence
in the original configuration; only the composite engine operates after activation.

## Interrupted conversion and matching settings

The journal lifecycle is `planned -> relocating -> ready-to-activate -> activated`, or `reversed` before activation.
Pre-activation journals retain a recovery-required flag and gate both old and proposed engines. Startup validates
the journal before scheduling. Missing, malformed or contradictory journal/gate/activation state stops plugin
loading or engine operation rather than falling back to v1. Retain all copies for investigation.

If an adapter operation fails, open Conversion and recovery. Resume and activate verifies backups, original
configuration and actual source/destination hashes before continuing proven substeps. Unexpected bytes or missing
source and destination stop recovery; preserve the copies and reconcile manually. Do not clear progress flags.

If any lifecycle settings save fails, its disk outcome may be uncertain. The running plugin blocks further engine
work and ordinary settings saves. Reload the plugin to read and validate persisted settings before choosing recovery.
If activation persisted despite the error, only the composite engine is eligible. Otherwise the original gated
journal remains recoverable. Never retry by overwriting disk settings with speculative in-memory settings.

Before activation, Reverse to original binding verifies matching settings and file backups, restores missing sources
from verified backups, and removes only unchanged destinations after verifying the restored source. Intervening edits
are retained and block reversal. Only the final verified settings snapshot restores the original configuration and
clears the gate. Reversal itself can be interrupted and resumed. After activation, reversal is unavailable: other
clients may have advanced remote state even if this client has never written. Back up and reconcile newer contents;
use detachment and a separately approved conversion rather than blindly restoring old backups.

For manual recovery from damaged plugin settings, disable the plugin and stop external writers first. Preserve the
current entire vault, current plugin `data.json`, and all recovery directories. Each conversion backup contains
`settings.json` (the matching pre-conversion settings) and `files/<original-path>` with captured bytes. Compare these
against the journal hashes and actual files. Restore original settings only together with verified original-path
contents and verified removal/reconciliation of relocated copies, before activation. Prefer the built-in reversal.
Restoring settings alone can point an old engine at relocated or newer files and infer destructive changes. If
activation occurred or evidence cannot be verified, retain everything and reconcile instead of restoring an old
baseline. Do not hand-edit a gate or journal to make the plugin start.

## Detach, remove, change prefix or re-add

Conversion and recovery offers Detach and keep files for the original binding and each composite mount. Confirm
explicitly even when the loss of access might be temporary. No proof of permanent membership loss is required.
The plugin invalidates old actions and drains operations before one atomic archive/disabled-state settings save.
The archive retains the original attributed configuration, captured writes, application/initial recovery, conflicts,
barriers and unresolved status. An unacknowledged dispatched write remains potentially committed. Failed archival
saves authorize no relocation and require reload. Stale callbacks cannot modify the saved archive.

Files remain at their existing paths. Composite siblings and independent DAV/service grants are unchanged; removing
membership or detaching a client does not revoke those grants. A detached original binding has an explicit disabled
marker and cannot fall back to v1. Removing the last composite mount retains an empty composite configuration.
Previously synchronized local copies cannot be remotely erased with a security guarantee.

Detachment is separate from conversion. After the archive is saved, preview and confirm a new authorized target
and explicit mappings for retained files. Old share access is unnecessary. To change a prefix, detach, then map
each retained file to the new prefix in a new conversion; direct initialized-mount retargeting is unsupported.
To re-add retained files at the same prefix, choose the target and leave file mappings empty. Fresh authorization creates
a new mount ID and empty reconciliation state. Initialize it explicitly. Restored access never replays archived
uploads or treats old baselines, upload IDs or permissions as approval. Archives remain local evidence.

## Evidence and limits

Automated fixtures inject failures before/after every conversion save, every adapter operation in conversion and
every reversal save. They cover binary bytes, corrupted backups, collisions, case aliases, symlinks, changed files
and configuration, malformed gate/activation evidence, failed archives, consent UI and ambiguous settings saves.
The real-server lifecycle scenario covers v1 and selected-share conversion, a committed write invalidated during
membership removal, unchanged sibling/credential state, restart, new-destination conversion without old access,
and fresh re-add after restoration. All data is synthetic and disposable.

Ubuntu/WSL checks on 2026-10-10: 229 plugin tests and the plugin build passed; 145 Rust tests passed with one existing
ignored sample-PDF test; all eight end-to-end scenarios passed. The final conversion conflict gate and form controls
also passed a focused plugin/build/lifecycle-scenario rerun. The generated `main.js` is updated.

Obsidian's adapter offers no cross-process compare-and-swap or transaction with plugin settings. Hash checks detect
observed changes but cannot exclude an external writer between the last check and a filesystem operation. Stop
external writers during conversion. Desktop filesystem adapters reject symlinks using guarded desktop-only inspection;
mobile adapters use their sandboxed adapter API without loading desktop filesystem modules. Human acceptance on
supported desktop/mobile devices, actual adapter behavior and operator-managed backup restoration remain pending.
No production deployment, migration, household document access or sibling-project changes are performed here.
