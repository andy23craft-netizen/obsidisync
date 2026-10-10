# FEAT-14: Explicit Cross-Mount Import

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)

## Problem and Desired Behavior

Cross-share rename is not atomic and can disclose private contents or lose the only copy. Provide an explicit
copy/import workflow that verifies destination acceptance before separately offering confirmed source deletion.
Detected local moves must use existing barriers rather than silently becoming destination uploads/source deletions.

## Dependencies

- Hard: [FEAT-11](FEAT-11-safe-writable-mount-sync.md), transitively FEAT-10, for mount setup, move records/generations,
  guarded writes, exact captured-evidence recovery and reconciliation release primitives.
- FEAT-12/13 are not hard dependencies: use fresh active mounts and scoped sync acceptance, not history/credential UI.

## Requirements and Proposed Contract

- Expose explicit import from active mounts and recovery of detected moves, naming both original/current paths and
  source/destination shares (or local-only endpoint). Reject plugin cross-mount rename before remote effects.
  Never represent copy plus delete as atomic; no automatic reversal of observed external/Obsidian filesystem moves.
- Preview selected files/attachments, captured bytes and privacy implications before import approval. Copy only
  explicitly in-scope attachment paths; do not follow links into another mount to collect private data. Preserve
  Markdown links unchanged and explain that relative/Obsidian links may need manual repair.
- Use collision-safe copies with verified bytes. Existing destination collisions require separate confirmed backup/
  reconciliation; never silently overwrite. Fresh verified recovery copies protect local bytes where replacement is
  approved. An already moved file is evidence at its current location, not proof destination upload was approved.
- Persist stable import ID, endpoint mount IDs/bindings/revisions/generations, original/current path mappings,
  captured hashes/deletions, backup/collision evidence, explicit decisions and per-file copy/verification/destination
  acceptance/source-delete intents and outcomes. Keep this local-only and use serialized snapshots plus adapter
  intents; markers alone are not completion proof. Restart inspects actual bytes and authorized remote evidence.
- Release only specifically approved destination barriers through FEAT-11 after saved consent and fresh captured
  evidence; source deletion remains blocked. Every write stage uses current authority/generation/barriers. A new move,
  account/configuration change or intervening edit invalidates outstanding approval; recapture and reconfirm.
- Destination success means the captured version is authoritatively accepted with no unresolved local/server conflict
  or barrier, not merely a staged upload or advanced head. Lost responses use fresh snapshot/conflict checks and
  captured evidence; consumed IDs are never replayed. Failure/ambiguity retains source/recoverable copies.
- Only then offer a separate source-deletion confirmation naming the source. Recheck source bytes, endpoint bindings,
  generations, capabilities and destination evidence before deletion. Persist intent first; use guarded local deletion
  and existing source-share sync journal for remote deletion. New edits, denied access, conflicts or ambiguous writes
  retain recovery evidence and stop automatic completion. Never delete a newer source based on an older approval.
- Where an observed move has already removed the source locally, do not claim import retained a nonexistent local
  source copy. Preserve verified current bytes/recovery copies and block original remote deletion; disclose actual
  state and require the same separate deletion approval. Never promise rollback of a submitted remote write.
- A local-only source needs no share capability but still requires byte checks and explicit local deletion consent.
  A local-only destination cannot satisfy remote acceptance or authorize remote-source deletion through this workflow.
  Keep the detected-move record and provide local reconciliation guidance for that case.
- Independently scoped ordinary same-mount rename remains supported. Read-only sources can be copied when readable,
  but source-share deletion is unavailable; read-only destinations cannot accept import. Unaffected mounts continue.
  Preserve protected-path exclusions, InkVault source omission/managed PDF rules and independent credentials.

## Proposed Implementation

Add explicit import/recovery UI using FEAT-10 move records/resolver and FEAT-11 guarded mutation/reconciliation
primitives. Persist import progress in versioned settings with attributable endpoint identity; reuse verified adapter
capture/backup/application rather than inventing parallel sync logic. FEAT-12's vault conversion journal is a separate
lifecycle: this ticket operates on active mounts and never activates a new composite configuration.

## Acceptance Criteria

- Approved import verifies copied text/attachments and destination acceptance before offering source deletion.
- Destination collision, checksum failure, partial staging, conflict or lost response cannot silently delete source.
- Restart recovers journal/files/server evidence conservatively; submitted requests never imply rollback or replay.
- Fresh consent releases only appropriate destination barriers; source deletion needs separate current approval.
- Detected moves retain recoverable bytes and original remote deletion barriers, even when local source is absent.
- Intervening edits/moves/binding changes invalidate approval; siblings and independent grants remain unchanged.
- Links remain unchanged, inaccessible targets are not copied, and local-only/read-only endpoints follow stated rules.

## Testing and Manual Verification

Test copy/collision/verification, selected attachments, rejected plugin moves and detected file/folder/root moves.
Inject restart/save failures at each intent and disk/network boundary, moves during upload, lost acceptance/deletion
responses, permission loss and concurrent source/destination edits. Assert source preservation/recovery evidence and
separate consent, using two principals plus private/shared real-server fixtures. Run plugin/build/Rust/e2e suites
in Ubuntu/WSL; manually verify import and failed import on disposable desktop/mobile notes. Document copy/import,
link limitations, already-moved recovery, local-only cases and why deletion is separately confirmed.

## Out of Scope

Atomic cross-share moves, automatic link rewriting, copying inaccessible attachments, server changes, production
migration/deployment and sibling repository edits. Conversion/detachment remains FEAT-12.
