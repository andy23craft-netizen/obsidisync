# Client share selection and retained synchronization state

The plugin implements share discovery and pending selection (FEAT-04A). V2 file synchronization, per-file read-only
reconciliation and the separate legacy/share credential UI are not implemented. Existing unconverted configurations
continue using v1. This is repository behavior, not a verified household deployment.

## Selecting and cancelling

In plugin settings, choose Server share selection -> Choose share. Discovery uses the advertised shareSyncV2 feature,
not the API version number: the current server advertises that feature with API version 1. Only authorized published
shares returned by the server are choices. Selection negotiates sync-state, then persists reconciliation-required
status. A label is display information, never an alias or permission.

The observed remote head is not a synchronized baseline. Existing v1 head, manifest, history references, initial-sync
and recovery state remain intact. No files are uploaded, downloaded or overwritten by selecting a share.
While pending, startup/timer/manual/close-triggered sync, vault actions and reset controls cannot mutate that state.
The separate legacy management UI is deferred to FEAT-04D; pending selection currently blocks its old vault actions
too, rather than silently routing them through an incomplete v2 implementation.

Reopen the chooser and Cancel pending selection to return to intentional v1 operation, provided the original
server/account/vault binding still matches. Dismissing the chooser without selecting leaves existing state intact.
Failure or denial leaves the previous pending selection intact; a v2 denial never triggers v1 fallback.

## Persisted ownership and authentication

- legacyManagementContext retains the original server/userSlug/vaultSlug. Login does not rewrite it.
- legacySyncBinding binds the existing baseline to that configured destination and, once observed, session subject.
  Changing server, user/vault namespace or a known account identity blocks reuse; it does not erase local data.
- authenticatedIdentity records the server's session response for client state ownership. It is not a membership
  credential and is never used to authorize a share. Manual token changes invalidate this cache; Server Check
  verifies the new session. Initial legacy configuration is adopted without resetting its stored baseline.
- pendingShareSelection retains server/share ID, authenticated session context, capability, observed head and an
  empty uninitialized share baseline. The authentication configuration marker distinguishes client configuration
  context; it never reconstructs an OIDC session issuer or resolves membership. The server owns those checks.

These fields are saved through Obsidian's plugin data store. Token refresh/re-login does not reset sync state.
Issuer-less OIDC sessions still require fresh server-verified login; development tokens still require explicit server
enablement, membership and legacy mapping. Ordinary production modes reject them. A 403 remains a capability error;
only 401 follows the session-refresh/login path, and inaccessible shares retain 404 behavior.

## Remaining implementation and validation

FEAT-04B owns safe downloads and durable per-file preservation; FEAT-04C owns writable share workflows;
FEAT-04D owns distinct legacy/share grant management. No pending selection can become active through FEAT-04A alone.
See the [FEAT-04 decomposition](tickets/FEAT-04-DECOMPOSITION.md) and
[server publication/migration contracts](SHARE_STORAGE_AND_MIGRATION.md).

Automated client tests exercise selection, cancellation/restart, identity changes, authorization errors, reset/sync
guards and old-server v1 operation. These do not replace actual desktop/mobile acceptance. No production migration,
deployment, Harmony/Marvin changes or ARM64 production image publication is implied.
