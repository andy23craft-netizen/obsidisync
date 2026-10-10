# PLAN-02: Composite Local Vault Synchronization

**Status:** Approved design; decomposed into proposed implementation tickets
**Owner:** Obsidian plugin
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** Implemented FEAT-02/03/04; preserve the
[FEAT-04 contracts and acceptance audit](../CLIENT_SHARE_SELECTION.md) and
[server storage/migration contracts](../SHARE_STORAGE_AND_MIGRATION.md).
**Refreshed:** 2026-10-10 against repository code; composite synchronization remains proposed.

## Implementation Tickets and Coverage

This plan replaces FEAT-05 and retains its full requirements. The following tickets collectively implement the
remaining work. Each owns its relevant unit/integration tests, manual fixture criteria and documentation updates;
there is no separate testing or miscellaneous ticket. Completed FEAT-02/03/04 remain prerequisites, not new work.

| Ticket | Owned behavior and plan coverage | Hard dependencies |
| --- | --- | --- |
| [FEAT-10](FEAT-10-scoped-mount-downloads.md) | Mount state/routing, fresh empty-vault setup, safe downloads, exclusions, scheduling/status, generation/barrier lifecycle and rename detection | Implemented FEAT-04 |
| [FEAT-11](FEAT-11-safe-writable-mount-sync.md) | Writable initialization/sync, per-mount conflicts/reconciliation, write-stage invalidation, submitted-outcome recovery and explicit reconciliation barrier release | FEAT-10 |
| [FEAT-12](FEAT-12-journaled-conversion-and-detachment.md) | Existing-vault conversion, durable activation/reversal, inaccessible-binding archive/detach, re-add and configuration lifecycle | FEAT-10, FEAT-11 |
| [FEAT-13](FEAT-13-mount-history-and-credentials.md) | History/snapshots, device/version metadata, separate share/legacy credential workflows and stale modal protection | FEAT-10, FEAT-11 |
| [FEAT-14](FEAT-14-explicit-cross-mount-import.md) | Verified explicit copy/import, attachment selection, persisted progress, destination acceptance and separately confirmed source deletion | FEAT-11 |

Recommended order is FEAT-10, FEAT-11, then FEAT-12/13/14. The latter tickets have no hard dependency on one another;
shared-file coordination is an ordering preference, not an additional contract dependency. FEAT-10 provides fresh
empty-vault mount setup so downstream work does not depend on the conversion UI merely to exercise composite sync.
Until FEAT-13, legacy single-share history/credential controls must fail closed in composite mode; until FEAT-14,
detected moves remain blocked with reconciliation guidance and no advertised unfinished import action.

Cross-cutting ownership: FEAT-10 establishes reusable mount resolution, action tokens, saved barriers and startup
gates; FEAT-11 consumes them for every mutation and recovery stage; FEAT-12/13/14 consume the same contracts rather
than implementing competing persistence/routing mechanisms. Each preserves authorization, privacy, InkVault and
legacy boundaries in its own paths. Final plan acceptance includes all tickets' evidence, the broader plugin/Rust/
real-server suites below and desktop/mobile fixtures; production migration remains separately authorized.

## Problem

One-share-per-local-vault is secure but makes people switch vaults between private and Harmony work. The plugin
currently supports one selected v2 share with guarded downloads and explicitly enabled writable synchronization.
It still scans one whole local vault, so it cannot route files to independently authorized shares. Unconverted
configurations retain intentional v1 behavior. FEAT-02/03/04 have no remaining implementation work; human
desktop/iPhone acceptance and production verification remain separate from repository implementation evidence.

`activeShare.download` already owns per-file baselines, observed head, local reconciliation, application intent,
write journal, initial backup evidence and separate server conflicts. Legacy `serverHead`/`localManifest` remain
separate. Composite work extends these safety contracts rather than replacing them with one manifest per vault.

## Desired Behavior

Each user configures one local vault with `Personal/` mapped to their private share and `Harmony/` mapped to the
shared share. Every mount has independent ID, capability, head, manifest, initial-sync/recovery decision, conflicts,
status, and retry. Local routing never weakens the server share boundary.

## Requirements

- Persist ordered `{localPrefix, shareId, display cache, perShareSyncState}` mounts. Prefixes are safe, non-empty,
  non-overlapping, and never claim root/protected configuration paths; one share is not mounted twice.
- Use one configured server and authenticated session for this first composite implementation. Bind each mount to
  the normalized server, verified identity and opaque share ID, never a label. Multi-server/account composition is
  out of scope. Reordering mounts changes presentation only; it cannot transfer state or authorize paths.
- Scan, change collection, upload/download, blob retrieval, deletion, manifest/head tracking, initialization, and
  conflicts only inside the owning prefix, with share-relative server paths.
- One mount's error/conflict/recovery action cannot reset, overwrite, or block safe retry of another. Read-only
  mounts retain v2 download behavior and reject writes.
- Treat `.obsidian`, `.obsidian-git-sync`, `.trash`, cache data, and plugin settings as composite-root local state;
  none may enter Personal/Harmony through path handling.
- Leave files outside all mount prefixes local-only, with clear settings/status guidance. Exclude `.git`,
  `ObsidiSync History` and recovery copies too. Apply exclusions to both local-prefixed and share-relative paths;
  a remote `.obsidian/...` must not become synchronized configuration under a mount. Existing v1/single-share
  ignore behavior is not globally broadened by this ticket.
- Reject plugin-initiated cross-mount rename/move before network activity. Offer explicit copy/import, destination sync validation,
  then separately confirmed source deletion; retain both copies after partial failure.
- Detected moves invalidate in-flight work using persistent barriers and per-mount move generations, including
  work already captured or staged. Submitted requests remain potentially committed until authoritative reconciliation.
- Conversion requires a durable relocation journal and one explicit settings activation boundary. Permanently lost
  original access permits confirmed detachment with archived evidence, never implicit conversion or upload approval.
- Preserve Markdown link text; links grant no access and are not rewritten. Attachments follow their local mount.
- Work through Obsidian's adapter on iOS/iPadOS/macOS without symlinks, union mounts, or desktop-only setup.

## State Migration and Server Constraints

FEAT-04's selected-share state is a prerequisite, not current composite functionality. Convert it only through
explicit user-chosen prefixes and per-mount reconciliation. Preserve prior settings/head/manifest and local files
until successful conversion; never infer share identity from Personal/Harmony labels. Back up before overwrite-local.

Keep capability, pending upload/conflict/recovery and retry state isolated per mount. Membership loss, expired login,
unpublished/retired share or credential revocation must not reset another mount or delete existing local copies.
Do not fall back to a legacy namespace after denied v2 access. Read-only mounts use non-mutating v2 negotiation/sync.

Carry FEAT-04's issuer-bound OIDC re-login and explicit development-principal behavior without aliasing identities.
Device/service grants remain independent and staged until explicit offline activation; mount changes cannot retarget
their immutable share/folder/capability or implicitly enable Saber. Legacy Saber stays within its original mapped share.

## Proposed Implementation

Replace singular selected-share state with versioned mount configuration and per-mount state. Add a normalized path
resolver that maps each vault-relative path to exactly one mount or composite-local excluded root. Refactor
`VaultState` and `GitService` to scan/apply beneath a mount while translating local-prefixed and share-relative
paths. Schedule/report initial sync, conflict, error, and retry per mount under the current overall sync command.

Add an explicit copy/import workflow rather than cross-share rename. It copies content/attachments, verifies
destination sync, then asks to delete source; failure retains source and reports recovery paths. Update settings,
status, initial-sync, conflict/history/device-password UI, ignore rules, tests/e2e, and README.

### Mount state and routing contract (proposed)

Use a versioned composite configuration with stable local mount IDs and a configuration revision. Each mount owns
its prefix, destination/identity binding, pending/active selection, capability, download-only/writable mode, complete
`ShareDownloadState` and status/error timestamps. Baselines, conflicts and journals use share-relative paths;
recovery evidence also identifies the mount and prefix. Never key recovery by labels or relative path alone.
Root history snapshots remain local; bind their source metadata to the mount/share. Existing unbound history remains
legacy/local evidence rather than being attributed to an arbitrary mount.

The resolver returns one mount and share-relative path, or local-only. Match path segments (`Personal` must not
match `Personal2`), reject absolute/traversing paths and prefix collisions, and reject case-equivalent mounts/files
where supported adapters would alias them. Validate remote paths before joining. Use the same boundary for history,
conflicts, blobs, device versions and mutable version metadata as for synchronization.

Capture mount ID, destination, prefix, configuration revision and per-mount move generation for asynchronous actions;
recheck before network mutation and local application. Settings/login changes and stale modals cannot redirect work. Preserve
serialized captured settings snapshots. Initially serialize mount operations; a failed mount cannot prevent later
eligible mounts from running. Authentication failure can pause the shared session without clearing mount state.

Retain full non-mutating read snapshots, checksum verification and per-file guarded application. Observed heads
never acknowledge local bytes. Recover application and staging/submitted/accepted write journals before uploading.
Lost responses acknowledge only exact captured evidence after authorized reads; never replay consumed upload IDs
or acknowledge a completion scan. Local reconciliation and server conflicts remain distinct. Keep local does not
approve upload; restored capability does not clear barriers. Recheck capability at every existing write stage.

Initial download starts download-only even for read-write members. Enable writes is explicit per mount. Initial
upload separately confirms replacement of that share, including remote-only deletions; adding a mount never
implicitly uploads an existing folder. Backups/replacement apply only to that mount. Preserve the existing
`inkVaultNotesV1` omission gate and managed PDF rules: unsupported source omission is not deletion, ordinary exported
attachments remain supported, and composite routing grants no source-editing or share-native Saber provisioning.

### Cross-mount operations and recovery

The current `main.ts` rename listener observes an already completed local rename. It cannot veto every Obsidian,
third-party or external filesystem move. Detected cross-mount file/folder moves must immediately block affected
source deletion and destination upload, invalidate in-flight work, persist recovery evidence and explain explicit
import. Cover moves into/out of local-only paths and mount-root renames. Never automatically undo filesystem moves
or interpret a missing mount folder as bulk-delete approval. Uncertain routing fails closed. Document that changes
made externally while the plugin is stopped cannot reliably be identified as moves; client routing is not an
access-control boundary against compromised endpoints or deliberate local copies.

Each mount has a persisted monotonic move generation. Detection synchronously advances generations and establishes
in-memory barriers for both affected mounts, then saves both generations/barriers and the move record in one
serialized settings snapshot. A local-only endpoint has no mount generation; block the affected mounted endpoint
and retain both path identities. Block affected mount writes until this save succeeds; save failure retains the
in-memory stop and reports recovery required. Persisted barriers survive restart. Do not reuse generations after
detachment/re-adding; new mount IDs prevent old operations from matching a new mount.

Every queued/captured asynchronous write holds its mount ID, binding, configuration revision and move generation.
Immediately before each upload initialization, chunk, completion, sync/resolve submission, mutable metadata request,
and import source deletion, check this token, current capability and barriers. Recheck after awaited preparation,
including journal saves and capability negotiation, immediately before dispatch. Apply the same validity checks
before response-driven acknowledgement, barrier changes and local application. Stale work cannot mutate, clear
barriers, advance a baseline or authorize deletion. Unaffected mounts remain eligible. The move barrier blocks
affected paths and their destructive application; reads may collect recovery evidence without applying over them.

Already dispatched requests may commit even if transport cancellation succeeds. Retain their original captured
evidence and staging/submitted/accepted journal; a stale callback may retain a response as recovery evidence but
cannot acknowledge it. Fresh recovery under the current generation/binding uses authorized snapshots and server
conflicts as in FEAT-04. Exact captured matches may establish only that version's outcome; divergent/conflicted or
unreadable outcomes remain unresolved. This recovery never clears the move barrier or approves source deletion.
Only a fresh explicit import/reconciliation decision can release the relevant barrier, after evidence is persisted;
new writes recapture state. Never replay consumed upload IDs or claim an already committed disclosure was rolled back.

Import previews both shares/paths, makes collision-safe verified copies and retains source contents. Destination
collisions require separate backup/reconciliation. Offer source deletion only after the captured destination version
is accepted without unresolved conflict/barrier. Persist progress across restart. Recheck source bytes, bindings
and capabilities before separately confirmed deletion; edits or ambiguous writes retain source. Attachments must
be explicitly in scope: never follow links into another mount to collect private data. Unchanged links may need
manual repair after relocation; link resolution must not trigger synchronization into another share.

### Local conversion and configuration lifecycle

Conversion is explicit, not a new-default migration. Preview affected files, root exclusions, chosen prefixes and
collisions; verify backups of files and matching plugin settings before relocating root-level content. Preserve
legacy/selected-share evidence as recovery data, not two active sync engines. A prefix move is not synchronization
proof: reconcile each mount. Interrupted conversion remains resumable and blocks uncertain writes without v1
fallback. Recover pending download/application/write journals and conflicts in their original binding before
conversion, or use the explicit inaccessible-binding detachment below; never rebase unfinished evidence onto a new
prefix. Re-login cannot change state ownership.

Persist the conversion journal in versioned plugin settings using the existing serialized snapshot save mechanism.
It contains a stable conversion ID, original server/share/identity binding, captured original configuration/settings
revision, target mount IDs and configuration, explicit source/destination mappings, source hashes, destination
absence/collision evidence, verified file/settings backup references, per-file intent/relocation/verification
progress, lifecycle state and activation revision. Preserve sensitive settings backups under the existing local
recovery boundary; do not log or expose their credentials. Journal evidence is local-only and excluded from sync.

The conversion lifecycle is `planned -> relocating -> ready-to-activate -> activated`; any uncertainty stops in
recovery-required state with the last phase/evidence retained. Before activation, verified reversal may finish as
`reversed`. Use this ordering:

1. Preview/validate eligibility, mappings, exclusions, collisions and backup requirements. Drain original operations
   and prevent new ones; an in-flight request cannot be assumed canceled. Recover it or detach with evidence.
2. Verify file and matching settings backups, rechecking captured files/configuration for intervening changes.
3. Save the complete `planned` journal and a conversion gate in one settings snapshot before any relocation.
   The gate disables the original engine and all proposed mount engines; no v1 fallback is allowed.
4. Save per-file intent before each filesystem mutation, then inspect and verify actual source/destination hashes
   before saving progress. Copy/verify/remove substeps each have intents; do not remove a changed source or overwrite
   a changed destination. Filesystem and plugin settings are separate operations, never an assumed transaction.
5. On restart, inspect source/destination presence and captured hashes regardless of progress markers. Matching
   copies can complete recorded substeps; unexpected bytes, collisions or uncertain absence stop for recovery.
   Preserve both copies when uncertain. Save `ready-to-activate` only after all mappings and exclusions verify.
6. The activation boundary is one successfully persisted settings snapshot containing the complete new composite
   configuration, matching activation revision and journal state `activated`, with the original engine disabled.
   New mounts are reconciliation-only, with writes disabled. Do not activate in memory before save success.
7. Independently authorize/reconcile each mount before explicit write enablement. Initial download/upload choices
   retain FEAT-04 confirmation and backup rules; relocation evidence alone is neither baseline nor upload approval.

Startup resolves the gate/journal before scheduling any sync. A pre-activation snapshot permits recovery/reversal
only; an activated snapshot permits only the new composite engine with its per-mount barriers. Missing, malformed
or contradictory conversion state fails closed, never selecting v1/defaults. A failed/ambiguous activation save
stops all affected engines until persisted state is reloaded and validated. Preserve the journal after activation.
This is a client persistence contract to implement, not a claim that the current adapter provides transactional
filesystem writes; retain FEAT-04's documented external-writer race and conservative interruption recovery.

Before activation, reversal verifies journal hashes and backups, retains intervening edits and restores matching
files/settings only when safe. Clear the conversion gate only in a final verified reversal snapshot selecting the
original configuration; do not blindly replace settings and lose the journal. After activation, preserve newer
contents and use reconciliation rather than treating the pre-conversion backup as current truth.

### Inaccessible-binding detachment and conversion eligibility

Permanent membership loss or inaccessible/retired shares may prevent original recovery. Offer explicit confirmed
detachment without requiring proof that access can never return. Explain that remote outcomes can remain unknown
and independent grants can remain active. Invalidate/drain local operations; dispatched requests remain potentially
committed. Durably archive original-binding journals, captured evidence, conflicts, barriers, initial recovery and
configuration before disabling that binding. Archive and detached status commit in one serialized settings snapshot;
save failure cannot authorize relocation or discard evidence. Stale callbacks cannot change detached/archived state.

Detachment retains local files, performs no remote deletion, credential revocation, v1 fallback or implicit grant,
and leaves sibling mounts and independent service/device grants unchanged. Archives retain original identity/share
attribution and unresolved status across restart. They are evidence, never completed sync or inherited upload approval.
Restored access or re-adding the share requires fresh authorization and explicit reconciliation, not automatic resume
of archived writes. Unknown remote outcomes remain documented until they can be authoritatively inspected.

Detachment alone does not relocate or convert files. Once its archive/disabled-binding snapshot is verified, retained
files are eligible for a separate explicit conversion plan into a newly configured mount: fresh authorization,
mapping/collision preview, verified backups and the same conversion journal/activation procedure apply. Disclose and
confirm the new destination before importing retained private contents. Original unresolved state stays archived;
only newly captured local bytes participate in new reconciliation. No access to the old share is required for this
local-file conversion, and no old baseline, journal or permission is transferred to the new binding.

Reject direct prefix/share retargeting of initialized mounts. Explicit removal detaches synchronization and retains
local files plus archived recovery evidence; it never deletes remote files or revokes credentials. Re-adding or
changing a prefix requires reconciliation. Pre-activation reversal follows the journal and verified backups.
After activation, take a fresh backup and reconcile newer contents instead of discarding them, even if this client
has not resumed writes: other devices may have advanced the remote share.

Credential UI names the mount and uses its share-native inventory with fresh authorization. Legacy management
keeps its original server/user/vault and management header, independently of mount capability. Active service/device
grants survive creator membership loss until explicit revocation or retirement; detachment does not revoke them.
Preserve staged activation, one-time secret handling and legacy Saber configuration/URLs.

Relevant files: `src/settings.ts`, `src/protocol.ts`, `src/gitService.ts`, `src/vaultState.ts`, `src/main.ts`, `src/initialSyncModal.ts`,
`src/shareSelection.ts`, `src/shareReconciliation.ts`,
history/conflict/device-password/settings UI, `ignore.ts`, tests/e2e, and `README.md`.

## Acceptance Criteria

- `Personal/` and `Harmony/` map to different authorized shares and retain independent heads/manifests/state.
- A file or binary attachment reaches only its mount's share; sibling mounts receive no path, metadata, or bytes.
- Initial reconciliation, backup/overwrite-local, conflict resolution, and retry occur per mount. Harmony conflict
  cannot alter Personal state.
- Root `.obsidian` and related local-only paths never upload to either share.
- Same-mount rename works. Plugin cross-mount moves are rejected before remote calls; observed Obsidian/external
  moves block destination upload and source deletion. Folder/root moves cannot become automatic mass deletion.
- Import retains source until the captured destination version is accepted without conflict and the user confirms
  deletion separately. Restart, collision, lost response and intervening edits preserve recoverable copies.
- Conversion verifies files/settings backups and resumes after interruption. Retarget/detach never silently reuse
  baselines, delete files, resume v1 or alter independent credentials.
- Stale actions cannot cross destination/account bindings. Equal relative paths in different mounts retain distinct
  history, blob, conflict, device metadata and recovery ownership.
- A move advances both affected generations and persists barriers. Stale queued/staged work cannot submit writes;
  stale responses cannot acknowledge contents or clear barriers. Submitted outcomes use fresh evidence-based recovery.
- Conversion saves its complete plan/gate before relocation and verifies actual hashes after interruption. Activation
  selects only the composite engine in one durable settings snapshot, with every mount initially write-disabled.
- Crashes before/after activation never enable two engines or v1 fallback; uncertain persistence stops for recovery.
- Lost-access detachment archives unresolved original evidence and retains files without remote effects. Restart or
  restored membership cannot replay archived writes. Separate confirmed conversion uses fresh destination authority.
- Downgrade/restart/restoration cannot auto-upload blocked edits; download-only mounts do not mutate server documents.
- A denied or failed mount leaves sibling state intact; eligible siblings can still synchronize.
- Links remain unchanged and documented; inaccessible cross-share links trigger no copying.
- Adapter-based behavior works on supported desktop and mobile platforms.

## Testing and Validation

- Unit-test path normalization, prefix collision rejection, resolver behavior, per-mount state migration, and root
  exclusions.
- Add client/e2e tests for isolated scanning/apply/manifests, attachment routing, references, independent initial
  sync/recovery/conflicts/retries, read-only mounts, same-mount rename, rejected cross-mount rename, and failed
  import retaining source.
- Test explicit single-share-to-mount conversion, retained old state after failure, authorization loss without
  fallback or sibling mutation, and destination verification before separately confirmed source deletion.
- Add fixtures for path aliases/protected remote paths, identical relative paths, stale modals, settings saves during
  sync/login, folder/root moves, detachment and interrupted conversion/import. Preserve InkVault omission/PDF rules.
- Inject moves before upload submission, during chunks, after submission before acknowledgement, with lost responses,
  and across restart with unresolved submitted work. Assert stale generations cannot mutate/acknowledge/clear barriers,
  exact-match recovery retains move barriers, and an unaffected third mount continues safely.
- Interrupt before/after every relocation filesystem operation, journal transition and settings save, especially
  activation. Check actual hashes versus misleading progress, concurrent edits, failed saves, safe reversal and
  startup rejection of inconsistent gate/configuration/journal combinations. Assert only one engine is eligible.
- Test permanent membership loss/inaccessible shares with pending application/write journals and conflicts; failed
  archive saves, confirmed detachment, restart, later restored access and separate conversion of retained files.
  Assert original evidence remains attributable/unresolved and grants/sibling mounts remain unaffected.
- Run `npm run test:plugin`, `npm run build:plugin`, `npm run test:server` and `npm run test:e2e` in Ubuntu/WSL using
  disposable data and synthetic credentials. Extend real-server e2e for two principals, private shares and Harmony:
  denied discovery/content/history/blob/metadata/upload/grant requests, isolated storage and non-mutating reads.
  Preserve WebDAV traversal/cross-share authorization coverage. Run packaged-command fixtures if packaging/admin
  contracts are affected; client-only changes need no unrelated container infrastructure.
- Exercise existing mobile-compatible adapter mocks and perform fixture manual checks on supported desktop/mobile.
- Local completion is build/tests plus fixture/platform checks. Production rollout, user migration, and live
  verification remain operator activities with backup and per-mount reconciliation.

## Documentation and Completion

Document owner-specific Personal mapping, Harmony setup, links, attachments, import, root exclusions, and recovery.
Completion means local implementation/tests pass; it does not assert deployed or live-verified behavior.
After actual-client acceptance and PLAN-02 validation, production migration remains one coordinated separately
authorized operation. Record exact commands/results and distinguish automated, manual fixture and live evidence.
No production access, deployment, live migration or Marvin/Harmony repository changes are authorized.

## Out of Scope

- Server share authorization/account administration/v2 storage contracts, atomic cross-share moves, link rewriting,
  multi-server/account composition, union filesystems, sibling repository edits, or document-semantic changes.
