# FEAT-04D: Legacy and Share Credential Management

**Status:** Proposed implementation
**Owner:** Obsidian plugin and Rust integration
**Parent:** [FEAT-04](FEAT-04-client-share-selection-and-migration.md)

## Problem

The current DevicePasswordsModal assumes legacy grants and immediate usability. V2 credentials are separately
stored staged grants; replacing the legacy UI with v2 calls would hide existing DAV/Saber grants.

## Desired Behavior

Users clearly distinguish retained legacy credentials from staged/active share-native credentials and manage each
through its proper authorization context. Existing Saber functionality and credential identity remain intact.

## Current Behavior

GitService list/create/revoke device methods all use vaultPath. DevicePasswordsModal supplies legacy URLs and Saber
instructions. v2.rs lists only share credentials and issues staged secrets; activation is explicitly offline.
http.rs legacy handlers check original namespace/mapping/membership: list needs read, create/revoke read-write.

## Requirements

- Consume A's separate original userSlug/vaultSlug context for existing v1 device-password management routes after
  v2 selection. Never derive this context from a share label, share membership or current login namespace.
- Only list/create/revoke/manage legacy grants when the server authorizes the current principal for that original
  namespace, mapping and operation capability. Do not register or retarget a vault just to manage credentials.
- Preserve legacy IDs, secrets, URLs, settings, encryption/PDF configuration and Saber workflows. Do not reissue,
  convert or migrate legacy Saber grants into share credentials.
- Show legacy versus share-native inventories and actions distinctly. Unavailable legacy management retains context
  and explains authorization/cutoff limitations without leaking inaccessible details or trying another namespace.
- Document that independent grants can survive creator removal/disable/downgrade while user-session management
  becomes unavailable. Native cutoff can also disable management while named DAV/Saber exceptions still serve.
  Explicit host-operator inventory/revocation remains available; do not weaken server checks.
- Use selected share v2 credential routes for share-native grants. Capability-aware creation requests read explicitly
  for read grants; the server defaults to read-write. Do not expose write issuance to read-only users.
- Display staged/active lifecycle and offline activation requirements. Preserve the one-time secret and ID; activation
  is not rotation/reissue and never happens automatically. Preserve failure/restart behavior without secret logging.
- Use exact share-ID Basic/OCS identity and returned DAV/Nextcloud paths; distinguish device bearer secrets from
  native sessions. Handle inventory/create response differences from legacy models rather than assuming identical fields.
- Respect current server capabilities for revocation: v2 deletion and legacy creation/revocation require read-write.
  Read-only members may issue read grants but need host-operator help to revoke if they lack write membership.
- Explain independent explicit revocation, retirement and scope; do not promise account disable revokes grants.
  New share grants must not provision Saber, scan tablet inputs, render or push. Legacy Saber instructions must
  clearly state their explicitly mapped original namespace boundary.

## Dependencies

[Implemented FEAT-04A](../CLIENT_SHARE_SELECTION.md) is a hard dependency for selected/legacy contexts and
capability-aware requests/errors. B/C are not hard dependencies; implementing after C is a review-order preference.

## Proposed Implementation

Extend protocol/device-password models, GitService credential routing, devicePasswords helpers and modal/settings.
Reuse A's destination/capability/error handling. Keep authorization server-owned; cached UI capability is not proof.
Use existing server lifecycle endpoints and offline activation; no server API change is required.

## Testing and Acceptance

- Test authorized legacy list/create/revoke after v2 selection, other members, namespace mismatch, missing context,
  lost creator membership, native cutoff and old-server v1 behavior. Assert retained context and no implicit conversion.
- Verify existing legacy grant IDs/URLs/settings and synthetic Saber configuration remain unchanged and grants can
  survive creator removal while unauthorized session management fails.
- Test staged creation, one-time secret display, activation status, read/write issuance, read-only revocation limits,
  share-ID Basic/URLs, active independent lifecycle, explicit revocation and retirement.
- Assert no new share grant enables Saber and no hashes/secrets/encryption passwords appear in inventories/logs.
- Document both workflows and operator limitations. Run required Rust/plugin/end-to-end/packaged suites if this is
  the final FEAT-04 child, and audit all parent acceptance criteria. Use disposable synthetic fixtures only.

## Manual Verification

A v2-selected vault shows separately labelled legacy and share grant sections. Legacy Saber remains usable with
unchanged settings; unavailable management explains the limitation without deleting context. A newly issued share
secret is clearly staged with offline activation instructions and correct share-ID URLs.

## Non-Goals and Boundaries

No share-native Saber provisioning, automatic activation, new grant administration API, native file sync or mounts.
No production access, deployment, migration, Marvin/Harmony changes or ARM64 production publication.
