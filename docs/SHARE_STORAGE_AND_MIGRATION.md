# Share storage, independent grants, and offline publication

This describes the server interfaces introduced by FEAT-03. Local fixture validation is distinct from deployment.
Complete FEAT-03, FEAT-04, then [PLAN-02](tickets/PLAN-02-composite-local-vault-synchronization.md) (FEAT-10 through
FEAT-14) before one separately authorized coordinated production migration.

## Authentication and storage boundary

Document storage is `data/shares/{opaque_share_id}`. Labels do not resolve storage. Native sessions require current
typed membership: local immutable account ID, verified OIDC issuer/subject, or an explicitly enabled development
verifier's distinct `development(canonical_configured_user)` principal. Inaccessible, unpublished and retired
shares return `404` before document or metadata access. Accessible write denial returns `403`.
Legacy issuer-less OIDC sessions cannot authenticate or refresh: fresh verified OIDC login is mandatory, as explicitly
approved. Current provider configuration never supplies a missing session issuer. Correctly bound sessions survive
restart until normal expiration/revocation; issuer changes cannot reinterpret a subject from another provider.

Development tokens do not resolve local/OIDC identities or grant global access. Provision explicit membership with
`membership grant SHARE_ID development USER read|read-write` and include `{"kind":"development","user":"USER"}`
in an explicit v1 mapping. The user must be canonical and match DEV_USER after normalization. Capabilities,
membership revocation, retirement and storage boundaries apply normally; token rotation preserves the identity but
rejects the old token. Local/OIDC auth modes never accept development tokens. The packaged image defaults to
AUTH_MODE=oidc, so merely supplying DEV_TOKEN cannot enable development. Explicit AUTH_MODE=dev is an opt-in for
local fixtures only; unpackaged absent-mode DEV_TOKEN opt-in remains for compatibility. Independent device grants
are separate credentials and still require explicit revocation; changing authentication mode does not revoke them.

`GET /v2/shares` lists accessible published shares. `/v2/shares/{id}/sync-state` negotiates without registration writes.
V2 supports sync, uploads/chunks/completion, history, file/blob (including HEAD/ranges), resolve, InkVault resolve,
devices, conflicts, device versions, version metadata, feed and device-password management. Paths and request models
follow their v1 counterparts; v2 version metadata also has GET. Advertised server features are additive.
No-change v2 sync serves the published head without upstream fetch/rebase, Git commits or device/version bookkeeping.
Changes and mutable endpoints require read-write membership. InkVault source access retains its client feature gate.

Reviewed exact `(legacy_user, legacy_vault) -> share_id` mappings preserve writable v1 registration and synchronization.
Both the URL user equality and the mapping's typed principal authorization remain mandatory, followed by membership
and capability. Another member of the same share cannot use someone else's legacy namespace. V1 and v2 use the same
share root, Git head and storage lock. Unmapped sources, retained old trees and labels never provide fallback access.

## Credentials and legacy Saber

Share credentials start staged. Explicit offline `credential share activate ID` requires a published non-retired
share and currently authorized creator. Activation changes only the manifest's activated-ID set; existing credential
ID, secret hash, folder and capability remain intact. Upgrade, migration and restart activate no credentials.

Once active, a credential is an independent share grant. Membership removal/downgrade and account disable do not
revoke it or reduce its capability. Disabling a person therefore does not stop their devices or Harmony's dedicated
service credential. Inspect inventories and explicitly revoke unwanted grants. Previously synchronized copies cannot
be remotely erased with a security guarantee. Retirement makes the share and all associated grants unavailable.

Basic username and OCS identity are the exact share ID. Use `/dav/{share_id}/{folder}/...` or
`/remote.php/dav/files/{share_id}/{folder}/...`; `/remote.php/webdav/...` exposes the authenticated folder as a virtual
mount. Bearer device secrets derive the same grant identity; they never become native sessions. Ambiguous credentials
are rejected. Folder traversal, symlinks, cross-share operations and write methods on read grants are rejected.

`credential share rotate ID local ACTOR_ID` and `... oidc ISSUER SUBJECT` allow an authorized replacement member
to rotate an independent grant after its original creator loses access. Creator attribution remains and the latest
rotation actor is recorded. The short `rotate ID` form checks the original creator. Revocation needs no membership.
Lists show effective lifecycle and scope, never hashes or encryption secrets.

Legacy DAV/Nextcloud/Saber grants retain their IDs, usernames, secrets, URLs, folders and encryption/PDF configuration
against their original explicitly mapped share. Existing Saber rendering, encrypted uploads, background pushes and
PDF deletion remain supported. Historical DAV folder restrictions do not limit the separate background `#tablet`
scan: it scans the original vault/share and may export linked PDFs outside the DAV folder within that same share.
It never searches another share. Relative links cannot escape the share; source and output symlinks are refused.
Workers recheck publication and live grant state before source reads and output writes. Revocation waits for an
already authorized storage operation, but can interrupt rendering between input reads and output publication.
After it returns, queued or cached work cannot publish using that grant.

New share credentials are ordinary WebDAV grants. They do not enable Saber provisioning, rendering, scanning or
pushing. Share-native Saber source/input/output configuration is deferred to a separate future feature.
Offline legacy issuance/rotation after publication additionally requires an explicit acting principal appended to
the existing command: `local ACCOUNT_ID` or `oidc ISSUER SUBJECT`. The actor must have write membership in the mapped
share. Existing client provisioning authenticates the typed session and checks the original namespace first.

## Client transition contract (FEAT-04)

The plugin supports intentional v1 sync and [share selection/reconciliation](CLIENT_SHARE_SELECTION.md) using the advertised
`shareSyncV2` feature. Selection preserves old state and blocks file synchronization until explicit reconciliation completes;
`/v1/server/info` reporting API version 1 does not mean v2 is unavailable. Old servers retain intentional writable
v1 operation, but v2 authorization denial must never cause automatic v1 sync fallback.

Read-only downloads use per-file safe application: only proven unchanged local files may receive remote updates
or deletions. Edited or uncertain files retain local state; overlapping changes create durable local reconciliation
records while unaffected downloads continue. Remote progress and synchronized file baselines must remain distinct.
Downgrade preserves edits/conflicts/recovery and stops writes; restored capability does not auto-upload previously
blocked edits. Explicit reconciliation is required, with local-only actions while read-only. Server read sync has
no merge-conflict semantics for this preservation; the client owns these records and restart-safe application.

V2 selection retains original user/vault as separate explicit legacy credential-management context. Existing
v1 device-password routes authorize original namespace, typed mapping and current membership: listing requires read,
creation/revocation read-write. V2 grant inventory does not include legacy DAV/Saber grants. The UI distinguishes
these stores without reissuing grants, changing secrets/settings/URLs or enabling Saber through new share grants.
Lost authorization or native cutoff makes client legacy management unavailable; retained context must not be deleted
or inferred from membership. Independent grants may remain usable, including named DAV/Saber cutoff exceptions.
Explicit host-local inventory/revocation remains the recovery path. Successful legacy inventories include the additive
`X-ObsidiSync-Legacy-Grant-Management: allowed|denied` header based on original namespace write authorization.
Only `allowed` enables client management controls; missing/unknown values fail closed. The JSON body and server
create/revoke authorization are unchanged. CORS exposes the header; unauthorized requests omit it.

## Empty installation setup

Every command uses the existing binary's `admin --data-dir /data ...` interface while the server is stopped.
First provision accounts, shares and memberships, then run `publication initialize` only on empty document storage.
Prepare a JSON setup file with `registration` (remoteUrl, branch, authorName, authorEmail) and optional explicit
`mapping` (user, vault, share_id, principals, native_enabled, dav_enabled). `share setup SHARE_ID CONFIG_JSON` creates
an absent root and publishes it. A failed setup never serves the unreferenced root; inspect it offline before retrying.
It does not infer aliases or overwrite an existing root. Do not use empty setup to bypass migration of existing data.

## Reviewed migration

1. Stop the server/workers and suppress automatic restart. Run `migration inventory`. Review all vaults, client
   consumers, grants, remotes, configuration and staged credentials. Prepare durable shares/memberships offline.
2. Make a filesystem-consistent complete backup, including users, auth/sessions/grants, configuration and existing
   publication state. Keep it in a separate protected directory outside the data tree, with no group/other access.
   Retain the old image/configuration. Never put secrets or backup contents in tickets or diagnostics.
3. Write a version-1 manifest with `set_id`, absolute `backup` path, `mappings` and `excluded` user/vault pairs.
   Each mapping names one existing share and explicit typed principals, with native_enabled/dav_enabled true for
   compatibility. Assign every unmapped legacy vault exactly once to a mapping or explicit archive-only exclusion.
   Targets are unique; repository merging is unsupported. Excluded vaults remain preserved and offline.
4. Run `migration dry-run PLAN_JSON`. It checks backup fingerprints, auth/publication state, source inventory,
   target collisions, local filesystem/capacity, links, remote policy, Git consistency, historical and working
   binaries, metadata, partial uploads, conflicts and Saber state. Resolve uncertain source/InkVault publication
   before migrating. The dry run changes no source or publication data. Review the returned manifest digest.
   Later sets also verify backup bytes for every already published share and refuse remapping/excluding an existing
   published legacy namespace.
5. Run `migration apply PLAN_JSON REVIEW_DIGEST`. The durable pending journal freezes ordinary administration and
   blocks startup. Complete copies are staged under `data/migrations/{set_id}/staged/{share_id}`, validated, synced
   and renamed into `data/shares`. Installed roots remain unavailable until the entire reviewed set is ready.
6. One synced atomic rename of `auth/share-publication.json` commits the complete mapping/authorization reference
   state. Accounts and grant stores are durable prerequisites, not separate atomic participants. Individual JSON
   writes do not make a multi-file transaction atomic. No staged credential is activated by migration publication.
   Completion is journaled and the journal is removed durably. Legacy source trees remain untouched recovery copies.
7. Run `validate` before restart. Startup refuses a pending journal, missing/corrupt authority, incomplete root or
   dangling references. There is no legacy fallback, second writable tree or automatic migration.

The migration command uses configured remote-host/local-remote policy. Keep that configuration consistent with the
server; permitting a local remote is an explicit configuration choice, never inferred from old storage.

## Interruption and rollback

`migration inspect` reports safe set/progress/digest information. `migration resume` revalidates frozen auth/source
fingerprints and the committed generation. Before commit it resumes validated installation; after manifest rename
it validates/finalizes the committed set. It never promotes leftover JSON temporary files or overwrites accepted
writes. A partial staged copy requires explicit `migration abandon REVIEW_DIGEST` and a new reviewed dry run.
Post-commit recovery verifies the exact reviewed manifest and unchanged installed bytes while the journal still
blocks all serving. A different generation/set or changed installation requires protected backup/manual recovery.
Abandonment removes only pre-publication journal-owned targets/staging, keeping sources, backups and previous
publication. It refuses if publication may have committed. Do not manually clear the pending journal to force startup.

Before any resumed writes, rollback means stopping all processes and restoring the complete verified pre-migration
backup plus the old image/configuration. After any resumed writes, take another complete backup and reconcile newer
notes, attachments, Git history, credentials and metadata first. Blindly restoring old trees after writes can lose
new data. A committed but inconsistent generation requires protected backup/manual recovery, not legacy fallback.

## Measured compatibility cutoff

Compatibility never expires automatically. `compatibility observe` starts/restarts a persistent observation epoch;
`compatibility status` reports the manifest and redacted counters. Native namespace activity, DAV grant activity and
Saber workers record IDs/protocol/count/last-use outside Git, without note paths, content, URLs or secrets.
Missing/reset telemetry restarts observation. Choose a finite interval covering the longest expected offline-client
return; elapsed time alone never proves client migration.

Prepare a review JSON with observed_since, observation_seconds, and consumers. Each consumer records share_id,
protocol (`native`, `dav`, `saber`), client identity, required (default true), migrated, reconciled, verified and retain.
Previously observed client IDs must be inventoried; explicitly non-required consumers need a verified disposition.
Unidentified namespace traffic requires a quiet interval and cannot be declared a non-required client. Native client inventory
must be complete; required consumers must have migrated/reconciled with replacement flows verified. Native activity
must be absent throughout the interval. Retained DAV/Saber consumers are named exceptions by grant ID/protocol;
all live legacy grants must appear in the review. Review `compatibility dry-run REVIEW_JSON`, then explicitly commit
`compatibility cutoff REVIEW_JSON REVIEW_DIGEST`. Native aliases return `410` only to authorized original principals;
inaccessible aliases still return `404`. Retained exceptions remain bounded by their named IDs and original scopes.
Do not claim full cutoff while exceptions remain. Notify users and archive old trees separately after recovery review.

## Automated validation

### V2 synchronization base and prior existence

V2 read synchronization intentionally records no device acknowledgements. For ordinary v2 writes, the supplied
base must be a commit available in the selected share repository and an ancestor of its current head. Invalid,
unavailable and unrelated bases are rejected before synchronization mutations. Prior file existence comes from
the server's Git tree at that validated base; unavailable tree/blob data fails closed. Client existence claims are
not used. Editing a base-present file deleted at the current head creates the existing edit/delete conflict rather
than recreating it. Unchanged stale content does not undo deletion. Genuine/concurrent creation and binary conflict
rules remain intact. V1 retains its original per-path device-acknowledgement semantics. Native InkVault keeps its
separate audited paired publication and expected-head resolution contract.

This narrow v2 correction is covered by the real-server read-first regression, including missing acknowledgements,
ordinary edits, null/invalid/unavailable/foreign/non-ancestor bases, new/concurrent files, binary conflicts and v1
compatibility. It does not authorize migration, deployment or changes to production data.

### Fixture suites

Use disposable directories/volumes and synthetic authentication for all migration/recovery tests. Run `npm test`,
`npm run test:e2e`, build the actual Dockerfile, and `python3 tests/packaged_commands.py --image IMAGE` against a locally
loaded image. Packaged fixtures use unique volumes and `--network none`, then remove only their own fixtures.
Automated checks do not replace human verification or authorize a production migration/deployment.
See the [implementation audit](SERVER_IMPLEMENTATION_AUDIT.md) for the inspected surfaces and fixture evidence.
