# Explicit cross-mount import

Open Settings -> Composite mounts -> Manage mounts -> Import and recovery. This workflow copies explicitly
selected files into an initialized, explicitly writable destination share. It does not activate mounts, change
credentials, rewrite links or perform an atomic cross-share rename. External/Obsidian moves are observed after
mutation and are never automatically reversed. Plugin-initiated composite renames reject cross-mount/root moves.

## Copy and approval

1. Enter one `source -> destination` mapping per line, using vault-relative paths, or select individual current
   files from a detected move. Folder and mount-root moves list their current files without selecting them by default.
   Include attachments explicitly. Markdown/Obsidian links remain unchanged and may need manual repair; the plugin
   never follows them to collect private files.
2. Preview the original/current paths, source/destination share labels and IDs, captured byte sizes and SHA-256 hashes.
   Destination members, server administrators and applicable backups can receive these contents and new history.
   A local-only source is allowed. A read-only source can be copied but cannot be deleted through share sync.
3. Existing local destination bytes require separate backup/replacement consent. Import verifies fresh recovery
   copies before guarded replacement. An already moved file is current evidence, not prior upload approval.
4. Approve copy/import only. Each remote creation requires freshly advertised `nativeSyncConditionalCreate` and
   sends exactly one upsert with `destinationCondition: "absent"`. Missing support stops without ordinary sync,
   resolve or WebDAV fallback. A competing destination returns `412`; `409` requires destination reconciliation.
   Import never merges with or replaces an existing remote destination, even with local replacement consent.

The plugin verifies actual destination bytes plus an authorized remote snapshot and conflict inventory. A staged
upload, successful HTTP response or advanced Git head alone is not acceptance. Only the exact approved file's
destination move barrier can be released. Folder/root siblings and original source deletion remain blocked.
Unrelated mounts continue their ordinary synchronization.

## Separate source deletion

After every selected destination is verified, a separate button names the original sources and asks for deletion
consent. The plugin refreshes identity, binding, generation, capability, local bytes, destination acceptance and
remote-source evidence. It persists local deletion intent before the guarded adapter operation, then uses the
existing source-share sync journal against the captured remote base. Remote source bytes differing from the
imported capture require reconciliation. Local-only sources require the same local checks and explicit consent.

For detected moves, the original source may already be absent locally. The dialog says so; verified current and
recovery copies protect bytes while original remote deletion remains blocked. A local-only destination cannot
establish remote acceptance and cannot authorize remote-source deletion. Retain its move record and reconcile
the local endpoints using Manage mounts.

Changes, denial, conflicts and uncertain outcomes stop completion and retain recovery evidence. A newer source
must not be deleted under older consent. A remote request may have committed before a failure; there is no promise
to roll it back. Previously synchronized copies on other devices cannot be remotely erased with a guarantee.

## Recovery and reconciliation

Imports use a versioned local settings journal with stable IDs, endpoint bindings/revisions/move generations,
original/current path mappings, captured local and remote evidence, consent, backup locations and per-file disk,
submission, acceptance and deletion intents/outcomes. Keep settings together with
`.obsidian-git-sync/backups/import-<id>/...`. Recovery copies are local-only and are not automatically removed.

Inspect and resume import checks disk bytes, fresh snapshots and conflicts. It never replays consumed upload IDs.
Interrupted staging or a divergent outcome becomes explicit share reconciliation. Lost submitted responses can
be recognized only through exact captured evidence. Source deletion still needs its own user action after restart.

For a stale/rejected plan, recover its ordinary share journal first. Recapture and preview again retains the original
sources/current locations and permits new absent destination paths. The new plan needs fresh approval; old evidence
and other unaccepted destinations stay protected. A source-deletion attempt cannot be replaced by a new import;
recover or reconcile its outcome first.

Preserve remaining copies; reconcile separately ends an import without further deletion or undoing submitted writes.
It first persists exact endpoint preservation records, then hands them to ordinary explicit local reconciliation.
Interrupted share journals are inspected using authorized captured-evidence recovery; an earlier move or deletion
attempt may already have removed an original source. Recovery copies and detected-move barriers remain.
Use Manage mounts to choose retained local bytes or backed-up remote contents;
source deletion is never inferred from ending an import. After reconciliation, capture a new import as needed.
This preservation decision can handle a newer move/configuration revision while the original binding still
matches. Inspect the latest detected move and reconcile its original endpoints before previewing its current
files again. A different server/account/share/prefix requires explicit recovery of the original binding evidence.

A failed intent save stops further engine work until reload/recovery. Unknown journal schemas fail closed. First
import approval saves composite schema 2 together with the import journal; earlier writable clients reject that
schema rather than ignoring source protection. Existing schema 1 mounts remain readable by this client and are
upgraded only when import is approved. Do not edit settings to clear barriers or force a downgrade. Desktop checks
reject filesystem links; mobile uses the vault adapter without loading Node filesystem modules. Protected paths,
InkVault sources and independent credential grants retain their existing boundaries. Obsidian adapters have no
cross-process compare-and-swap; arbitrary external writers can race the last local check.

## Automated evidence and deployment

Synthetic plugin tests cover selected attachments/unchanged links, local/remote collisions, partial staging,
checksum failures, intent-save failures, lost responses, source/destination edits, account/generation/permission
changes, file/folder/root moves, per-file release, local-only/read-only sources and mobile adapters. The real-server
fixture uses two principals and private/shared shares, verifies inaccessible discovery, byte-preserving import,
conditional collision rejection, recapture and lost acceptance/deletion recovery.

Ubuntu/WSL checks on 2026-10-10: 287 plugin tests and the plugin build passed. The Rust suite passed 152 tests
with one existing ignored sample-PDF test. All ten e2e scenarios passed; the import scenario passed again after
the final preservation/recovery changes. `git diff --check` passed.

No server storage migration is introduced. Deploy a server advertising `nativeSyncConditionalCreate` before using
the updated plugin's import workflow. Automated fixtures do not establish production deployment or human
desktop/mobile acceptance. No live household data or sibling repositories are modified.
