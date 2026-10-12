# WebDAV conditional creation

WebDAV PUT supports atomic create-if-absent on DAV and Nextcloud mounts. This is a generic storage operation;
applications such as Harmony own document identity, operation journals and reconciliation after uncertain outcomes.
Native v2 JSON conditional creation is a separate API contract.

## Request and authorization

```http
PUT /dav/{share_id}/{granted_folder}/Projects/example/project.md
Authorization: Basic <existing activated device credential>
If-None-Match: *
Content-Type: text/markdown
```

Use the exact opaque share ID as Basic username for a share-native grant. Retained mapped legacy credentials keep
their existing URLs and identity. Native bearer sessions do not grant DAV access. Credentials must be activated,
write-capable and scoped to the destination share/folder. Share publication, revocation, traversal and symlink
checks precede storage conditions. An independent share grant does not enable legacy Saber rendering.

Create parent collections one level at a time with MKCOL before PUT. The credential's granted root is a virtual
collection even without a physical directory. Other missing parents are not created by conditional PUT.

| Request or destination | Result |
| --- | --- |
| Exactly one `If-None-Match: *`, with optional surrounding whitespace; absent file, existing parent | `201 Created` after normal Git/remote/device completion. |
| Existing text, binary, zero-byte, identical-content or partial/uncommitted file | `412 Precondition Failed`; the rejected request does not replace bytes, commit history or clear conflicts. |
| Descendant collection / granted root | Existing `409` / `405` method errors; never replaced by a file. |
| Missing or non-collection parent | `409`, checked under the writer lock; no implicit ancestors. |
| Empty/malformed value, tag list, combined wildcard values or duplicate field lines | `400`; never unconditional fallback. |
| Supported exact If-Match plus wildcard absence | `412`: If-Match is evaluated first and both cannot succeed. Ordinary method/parent errors take precedence. |
| If-Match alone | Existing exact quoted tag comparison, including `412` for unsupported values. |
| Neither header | Existing last-write-wins `201`/`204`, including implicit ancestor creation. |

This deliberately implements a restricted wildcard PUT profile, not general If-None-Match tag lists. Read-only
grants return `403`; unusable credentials and inaccessible shares/folders retain existing authentication/masking
errors before revealing destination presence. Existing body limits, partial-PUT refusal and timestamp handling apply.

## Receipt

A successful conditional creation returns an empty body and `X-ObsidiSync-Revision: <final Git commit id>`.
The revision is captured after completion while the share lock is still held. It identifies share history,
not a globally ordered operation ID or HTTP validator. Missing final head or file inspection errors prevent success.

The response also includes the existing quoted file ETag when the final bytes equal the staged input. The writer
hashes input before consuming its stage and compares final bytes under the lock, without holding another large
upload in memory. Remote integration or checkout transformations can change the representation; then ETag is omitted
and the client must GET the result. This follows [HTTP PUT validator restrictions][put]. Text ETags encode size/mtime,
not a content hash or durable file incarnation. `X-OC-Mtime: accepted` remains available where applicable.

## Concurrency and recovery

Absence checking and mutation share one storage mutex with cooperating native v1/v2 sync, DAV PUT, MOVE, COPY,
DELETE and MKCOL. With successful local persistence and no intervening deletion, two conditional creates have one
winner. A later unconditional PUT can replace the result; creation does not reserve a path. External Git writers,
privileged filesystem edits and binaries that ignore the data-directory process lock are separate trust boundaries.

No success precedes the existing Git/remote/device completion path. This does not make direct file writes and Git
crash-atomic or guarantee power-loss durability. A timeout, cancellation, restart or post-mutation failure can leave
a partial/uncommitted file or a completed commit, even without a receipt. A remote conflict can require Obsidian
resolution. Final representation changes require read-back. Do not infer failure to publish from an HTTP error alone.

Retain the condition on retry: present files return `412`, including partial files and identical bytes; an absent
destination may be created. Never fall back to unconditional PUT, delete surviving content or claim replay success
because bytes match. Read back document identity/content and inspect history against the application's durable
journal. `412` cannot identify the original creator; delete/recreate permits path reuse without exactly-once delivery.

Returned streaming, precondition and persistence errors clean stages through the normal wrapper. Cancellation or
crash can leave stages; retain recovery evidence and inspect storage offline as needed. Do not use live data in tests.

MKCOL creates no durable document identity. Empty directories may remain after a failed PUT and must not be
automatically removed: another writer may have populated them. Empty collections are discoverable over DAV but
are not guaranteed through Git reconstruction or file-manifest sync. A committed manifest file supplies durable
identity; no `.gitkeep` or directory registry is added.

## Validation and rollout

Automated disposable fixtures cover conditions, receipts, restart/reconstruction, controlled competing streams,
native/DAV/MOVE/COPY ordering, active and legacy grants, Nextcloud mounts, path refusal, upload failure, remote
completion failure and transformed representations. Existing If-Match, Obsidian synchronization and Saber tests
remain applicable. Automated local checks do not establish deployed or human-verified behavior.

No data schema, migration, credential activation or client sync-state change is required. Before rollout, the
operator must verify that the actual proxy forwards condition/receipt headers and preserves `201`/`412`, then
exercise Harmony reconciliation and existing Obsidian/Saber clients in an authorized integration environment.
Deployment and provisioning remain Marvin/operator responsibilities.

[put]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4
