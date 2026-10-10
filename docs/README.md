# Documentation

Start with the [project README](../README.md) for installation and normal use.

- `runbook/`: setup, operation and recovery procedures for users and operators.
  Start with [share selection](runbook/CLIENT_SHARE_SELECTION.md),
  [composite mounts](runbook/COMPOSITE_MOUNT_DOWNLOADS.md) or the
  [server migration runbook](runbook/SHARE_STORAGE_AND_MIGRATION.md).
- `maintainers/`: [release procedure](maintainers/RELEASING.md) and
  [implementation audit](maintainers/SERVER_IMPLEMENTATION_AUDIT.md).
- `technical-reference/`: [InkVault protocol](technical-reference/INKVAULT_NOTES_V1.md) and
  [WebDAV conditional-create investigation](technical-reference/WEBDAV_CREATE_IF_ABSENT_RESEARCH.md).
- `architecture/`: [system structure and diagrams](architecture/README.md).
- `tickets/`: outstanding work, currently [WebDAV atomic creation](tickets/FEAT-06-webdav-atomic-create-if-absent.md).

Repository implementation and automated test evidence do not establish production deployment or human acceptance.
