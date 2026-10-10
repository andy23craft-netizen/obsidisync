# FEAT-12: Journaled Conversion and Detachment

**Status:** Proposed implementation
**Owner:** Obsidian plugin
**Parent:** [PLAN-02](PLAN-02-composite-local-vault-synchronization.md)

## Problem and Desired Behavior

Existing v1/single-share vaults need explicit safe conversion into mounted shares. Filesystem relocation and plugin
settings are separate writes; interruption must not activate two engines or lose data. Permanently lost access
must permit archiving/detachment without forcing unresolved original work into a new share.

## Dependencies

- Hard: [FEAT-10](FEAT-10-scoped-mount-downloads.md) for mount configuration, startup gates and scoped downloads;
  [FEAT-11](FEAT-11-safe-writable-mount-sync.md) for recovery and per-mount reconciliation/write enablement.
- Preserve existing v1 and selected-share evidence, [FEAT-04 contracts](../CLIENT_SHARE_SELECTION.md) and independent
  service/device grants. Conversion performs no server migration, credential retargeting or publication.

## Requirements and Proposed Contract

- Explicit preview names source binding, target shares/prefixes, files, exclusions, collisions and backup requirements.
  Labels never infer identity. Stop new original operations and drain/recover dispatched work before conversion;
  recover existing downloads/application/write journals/conflicts in original bindings or explicitly detach below.
- Verify file and matching settings backups under local-only recovery storage. Preserve sensitive credential-bearing
  settings privately; no logging or sync of backups. Recheck captured files/configuration for intervening edits.
- Store a durable conversion journal in versioned plugin settings with stable conversion ID, original server/share/
  identity binding, captured original configuration/settings revision, target mount IDs/configuration, all explicit
  source/destination mappings, source hashes, destination absence/collision evidence, verified backup references,
  per-file intents/relocation/verification progress, lifecycle state and activation revision.
- Lifecycle: `planned -> relocating -> ready-to-activate -> activated`; uncertainty retains last phase/evidence and
  recovery-required state. Verified pre-activation reversal can finish `reversed`.
- Persist complete `planned` journal plus conversion gate in one serialized snapshot before any relocation. Gate
  disables original and proposed engines. Save intent before every filesystem mutation, including copy/remove
  substeps; verify bytes before progress saves. Never overwrite changed destinations or remove changed sources.
- On interruption inspect actual source/destination presence and captured hashes, regardless of progress markers.
  Resume proven substeps only; unexpected bytes/collisions/uncertain absence preserve copies and require recovery.
  Save `ready-to-activate` only after all mappings/exclusions verify. The adapter and settings are not a transaction.
- Activation is one successfully persisted settings snapshot containing complete new composite configuration,
  matching activation revision, `activated` journal and disabled original engine. New mounts are reconciliation-only
  and write-disabled. Do not activate in memory before save success. Independently authorize/reconcile each mount
  before explicit write enablement; relocation hashes are not baselines or upload approval.
- Startup resolves journal/gate before scheduling. Pre-activation state permits recovery/reversal only; activated
  state permits only composite operation with barriers. Missing/malformed/contradictory transition state never falls
  back to v1/defaults. Failed/ambiguous activation save stops affected engines until disk state is reloaded/validated.
  Preserve activated journal. Retain FEAT-04 conservative recovery and documented external-writer race.
- Pre-activation reversal verifies backups/journal hashes and retains intervening edits. Clear gate only in final
  verified reversal snapshot selecting original configuration. After activation back up/reconcile newer local/remote
  contents, even before this client writes; other devices may advance the server. Never blindly restore old backups.
- Offer user-confirmed inaccessible-binding detachment without proof access can never return. Explain unknown remote
  outcomes and independent active grants. Invalidate/drain local operations; dispatched writes remain potentially
  committed. Archive original-binding journals/captured evidence/conflicts/barriers/initial recovery/configuration
  and disabled/detached status together in one serialized snapshot. Failed save never authorizes relocation.
  Stale callbacks cannot modify detached/archived state. Archives retain original attribution and unresolved status.
- Detachment retains local files and performs no remote deletion, credential revocation, legacy fallback or implicit
  authorization. Sibling mounts/grants are unchanged. Restoration/re-add requires fresh authorization/reconciliation
  and a new mount ID; archived writes are never replayed or treated as approval/completed synchronization.
- Detachment does not convert files. After archive/disabled-state verification, separately confirmed conversion of
  retained bytes needs a new authorized destination, mapping/collision preview, backups and the same journal/gate.
  Disclose destination privacy implications. Old access is unnecessary, but no old baseline/journal/permission moves.
- Own explicit detach/removal, re-add and prefix lifecycle UI. Reject direct retargeting of initialized mounts;
  changing prefix requires reconciliation. Preserve existing settings/history/recovery as evidence, not active engines.

## Proposed Implementation

Extend `src/main.ts` load/save/startup eligibility and `src/settings.ts` versioned state; add conversion/recovery UI
alongside selection/initial-sync flows. Use scoped adapter capture/backup primitives, serialized snapshots and action
tokens from FEAT-10/11. Implement conversion intents separately from ordinary share application/write journals.
Root config, unsupported sources and recovery/history stay local-only; no semantic transformations or symlinks.

## Acceptance Criteria

- Existing v1 and selected-share conversion preserves bytes/settings evidence and reconciles independently per mount.
- Every mutation has durable intent; recovery uses actual hashes even when progress lies or settings saves fail.
- Crashes immediately before/after activation never select two engines or v1 fallback; uncertain state stops safely.
- Safe pre-activation reversal retains intervening edits; post-activation recovery preserves newer remote/local data.
- Lost-access detach with pending journals/conflicts survives restart with attributable unresolved archives and files.
- Restored access never resumes archived uploads; separate conversion uses fresh destination consent and authority.
- Prefix retarget/removal/re-add changes no remote contents or independent credentials implicitly.

## Testing and Manual Verification

Inject interruption before/after every journal transition, adapter operation and settings save, including both sides
of activation. Test mismatched hashes, collision, changed source/destination, stale callbacks, safe reversal and
corrupt/missing transition state. Test permanent membership loss with application/write journals/conflicts, failed
archive saves, restart/restoration and new-destination conversion. Assert unchanged grant inventory/sibling state.
Run plugin/build/Rust/e2e suites in Ubuntu/WSL on disposable data. Manually convert/recover fixture vaults on supported
desktop/mobile adapters. Document backup/activation/reversal/detachment and matching-settings restoration steps;
report fixture evidence separately from production migration, which remains unauthorized.

## Out of Scope

Server storage migration/admin changes, production operations, credential revocation and importing between active
mounts (FEAT-14). FEAT-13 owns history/credential presentation, not conversion or archive mechanics.
