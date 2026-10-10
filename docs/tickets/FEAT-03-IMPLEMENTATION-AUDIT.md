# FEAT-03 implementation audit

This records source inspection and disposable automated regression evidence for the reviewed FEAT-03 contracts.
It is not human acceptance, deployment, production migration, or verification with actual Obsidian/Saber clients.
The feature ticket remains available for comparison and later ticket refresh. FEAT-04 has not begun.

## Contract and surface audit

| Surface/contract | Enforcement and automated evidence |
| --- | --- |
| Identity | `auth.rs` derives local, verified issuer/subject, or explicitly enabled development identity from its verifier. `accounts_tests.rs` covers issuer-less access/refresh rejection, new-session persistence, issuer collisions/change, restart and unrelated authentication preservation. `share_protocol_tests.rs` covers distinct development identity, production rejection, explicit membership/mapping, capability, token rotation and revocation. |
| Packaged authentication | The Dockerfile defaults AUTH_MODE to oidc. Packaged fixtures check image configuration and run its real entrypoint with absent auth settings and an injected development token: startup still demands OIDC. Explicit password mode rejects the token; explicit dev serves only its member/mapped share. Password containers explicitly select AUTH_MODE=password. |
| Native v1 | Each vault handler authorizes URL namespace, reviewed typed mapping, current membership and requested capability before storage. Tests exercise registration, synchronization, conflicts, upload retry, history, binaries and metadata on mapped roots; interleaved v1/v2 writes share one root/head/lock. The negative route matrix covers every existing vault route and inaccessible/nonexistent equivalence. |
| Native v2 and read-only access | `v2.rs` performs common authentication/publication/read authorization before dispatch, then write authorization where required. Tests cover discovery, negotiation, read sync, file/blob/ranges, history, uploads, conflicts, devices, version metadata and credentials. Storage snapshots prove read-only success and denied writes do not mutate share state. Read sync performs no registration, remote refresh or device/version bookkeeping. |
| Browser/API activity | Feeds filter published membership and, for native legacy feeds, original namespace/mapping before repository access. Browser-cookie and API fixtures verify private data and share identities are absent for another principal. |
| InkVault | Source access retains protocol capability gates. Publication/recovery/resolve uses share roots and the shared lock. All InkVault integration fixtures use published storage, including conflicts, paired source/PDF changes, durable interruption/recovery, symlink safety and legacy compatibility. Native negative matrices include InkVault resolution. |
| Direct DAV | Active grant authentication precedes scoped storage. Read/write capability applies to every method, including locks. Published tests cover PROPFIND ancestors/depths, content, ranges, conditional writes, uploads, collections, COPY/MOVE, deletion and locking. Cross-share operations and encoded traversal have no source/destination effects. |
| Nextcloud/OCS | Basic and bearer device credentials resolve the same grant. OCS identity is the exact share ID for share grants. URL identities are checked before access; share-native folder URLs use the scoped folder layout. Legacy Saber retains its virtual Saber mount. Tests cover positive Basic/bearer DAV/OCS, mismatched usernames/URLs, cross-share denial and legacy login/connect/polling. Avatars and discovery return static protocol information, not share storage or inventories. |
| Legacy Saber workers | Only mapped legacy Saber grants enable rendering and vault-wide tablet export. Workers recheck publication, retained protocol permission, live revocation and original share boundaries around input/output operations. Mapped fixtures cover encryption/PDF settings, rendering/deletion, exports outside DAV folders but inside the original share, revoked queued/cached work, source symlinks, traversal links and another published share's private PDF. Plain share DAV writes do not render or provision Saber. |
| Independent grants | Explicit activation changes only the manifest's active-ID set and preserves credential bytes. Existing grants survive creator disable/removal/downgrade; issuance/activation/rotation checks the acting member. Inventories and explicit revocation remain available offline. Retirement denies all grants and content. Integration and packaged fixtures cover staged rejection, preservation, rotation attribution, independence and revocation. |
| Publication/recovery | One manifest decides the reviewed routing/activation state. Offline locking, verified backup, staged copies and the durable pending journal provide prerequisites and startup exclusion. Migration tests cover twelve interruption checkpoints, each root install in a two-share set, changed source/auth state, corrupt committed state, collisions, schemas, links, capacity and excluded vaults. Later sets verify backups of existing published roots and reject alias remapping. Post-commit recovery checks the exact reviewed manifest and installed bytes before clearing the barrier. |
| Rollback/cutoff | Disposable tests rehearse pre-write complete backup restoration and prove committed recovery cannot overwrite newer writes. The runbook requires fresh backup/reconciliation after resumed writes. Persistent redacted consumer evidence and explicit reviewed cutoff are tested, including missing telemetry, retained named DAV/Saber grants, required consumers, refusal and authorized 410 versus inaccessible 404. No timer or startup disables v1. |

Git operations explicitly bind their repository and work tree to the resolved root; retained core.worktree settings
cannot redirect bookkeeping into another share or the old legacy tree. Path checks reject symlink escapes before
source reads and output writes. Legacy trees remain offline recovery copies, never fallback or a second writable tree.

## Automated validation and remaining verification

Final WSL results on 2026-10-08:

| Check | Result |
| --- | --- |
| `npm test`: plugin | 74 passed, 0 failed; TypeScript/plugin build passed. |
| `npm test`: Rust | 144 passed, 0 failed, 1 existing ignored PDF inspection test. |
| `npm run test:e2e` | All ten scenario steps passed against mapped v1 share storage. |
| Dockerfile build | Passed; final locally tested image ID starts `a24e25e7b7d3`. |
| Packaged commands | Passed with network disabled, including actual production-default rejection and explicit dev membership/mapping. |
| Rust formatting and `git diff --check` | Passed. |

There are no unresolved test failures. A WSL command-launch connection timeout was retried successfully during
image validation; it was not an application test failure.

Required commands are `npm test`, `npm run test:e2e`, the actual Dockerfile build, and
`python3 tests/packaged_commands.py` against that locally built image. Packaged fixtures use unique disposable volumes
and network isolation. All authentication, migration, encryption and recovery fixtures use synthetic inputs.

Interruption tests inject faults at persistence checkpoints; they do not simulate hardware power loss. Capacity
rejection is fixture-tested with an impossible declared requirement, not a full physical disk. Human acceptance with
real desktop/mobile Obsidian, Saber and other DAV/Nextcloud clients remains outstanding. No production behavior has
been accessed or verified. Production needs separately authorized inventory, approved mappings, protected backups,
OIDC re-login communication, explicit authentication configuration and the coordinated migration runbook.

The audited implementation has no unresolved product decisions. Legacy share-native Saber provisioning remains
explicitly deferred; completed legacy Saber compatibility is retained. Implementation order remains
FEAT-03 -> FEAT-04 -> PLAN-02 (FEAT-10 through FEAT-14), followed by one separately authorized production migration
after validation. See [the composite plan](PLAN-02-composite-local-vault-synchronization.md).
