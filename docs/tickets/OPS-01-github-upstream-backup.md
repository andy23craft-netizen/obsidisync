# OPS-01 - Configure a GitHub remote for additional text-history backup

**Status:** Proposed  
**Owner:** Operator, with deployment support from Marvin  
**Dependencies:** Access to the target GitHub account and the running ObsidiSync deployment

## Goal

Configure a private GitHub repository as an additional off-host copy of an ObsidiSync share's Git-tracked text and
code history, using the existing optional Git remote support.

## Context

ObsidiSync fetches, rebases and pushes to a configured Git remote during normal writable sync. The remote receives
text/code files and the binary manifest, but not attachment object bytes, authentication data, upload state or the
rest of the server's `/data` directory. This is a supplementary copy, not a complete server backup. Continue the
consistent full `/data` backup procedure in the [README](../../README.md#backup-and-restore).

GitHub is an external trust boundary and receives readable text contents. A private repository limits who can
access it through GitHub, but does not encrypt its contents. Marvin owns deployment and secret mounting; this ticket
does not change host configuration itself.

## Scope

- Create a dedicated private, empty GitHub repository for the target share. Do not initialize it with a README,
  license or other commit.
- Configure a dedicated SSH deploy key for that repository and mount its private key and verified `known_hosts`
  file into the server runtime read-only. The key must be usable by the container's `obsidian-sync` user (UID
  `10001`) and have mode `0600`.
- Allow `github.com` in `OBSIDIAN_GIT_SYNC_ALLOWED_REMOTE_HOSTS`, preserving any other required hosts.
- Configure the remote as `git@github.com:OWNER/REPOSITORY.git` using the supported setup path for the target.
- Preserve existing `/data` backups and verify that text history reaches GitHub after a normal sync.
- Treat the repository as server-managed. External commits can be fetched and integrated by ObsidiSync on a later
  sync, so operators should not use it as an independent editing destination.

## Operator procedure

### GitHub repository and key

1. Create a private, empty repository. Keep its default branch as `main`.
2. Generate a dedicated SSH key pair on the server host. Store the private key in the host's protected secret area;
   do not put it in the repository, container image, command arguments, environment variables or tickets.
3. Add the public key under the repository's **Settings -> Deploy keys** and enable write access. A deploy key is
   scoped to one repository. A write-enabled deploy key can push, so restrict its use to this share's repository
   and revoke it if the host or key is compromised. See [GitHub deploy key guidance](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).
4. Mount the key and a `known_hosts` file populated from GitHub's verified SSH host keys into
   `/home/obsidian-sync/.ssh` as read-only files. Confirm the container user can read them without making the
   private key accessible to other host users.
5. Configure `OBSIDIAN_GIT_SYNC_ALLOWED_REMOTE_HOSTS=github.com` in the server environment, retaining other
   allowed hosts if needed, then restart the server without changing its data volume.

### Select the supported configuration path

- **New v2 share:** include the remote in the `registration` object of the setup JSON passed to
  `admin --data-dir /data share setup SHARE_ID CONFIG_JSON`:

  ```json
  {
    "registration": {
      "remoteUrl": "git@github.com:OWNER/REPOSITORY.git",
      "branch": "main",
      "authorName": "ObsidiSync",
      "authorEmail": "obsidisync@example.invalid"
    }
  }
  ```

- **Existing legacy v1 vault:** the plugin sends `remoteUrl` during registration, but does not currently expose a
  visible control for it. Back up the local plugin settings, then set
  `"remoteUrl": "git@github.com:OWNER/REPOSITORY.git"` in that vault's
  `.obsidian/plugins/ios-git-sync/data.json`, preserving all other settings. The next sync sends registration.
  This file contains session data; never share it for troubleshooting.
- **Existing selected v2 share:** the current offline admin CLI has no supported operation to add or change the
  remote on an already published share. Do not edit `state.json` by hand. Stop this procedure at that point and
  use a separate implementation change to add a supported operator command or migration path before configuring
  that share.

### Verify and recover

1. Confirm the target repo is empty before the first push. If it already has commits, stop and reconcile histories;
   do not force-push.
2. Sync a small, disposable text change through ObsidiSync and verify the resulting commit appears on GitHub's
   `main` branch.
3. Clone the private repository to a protected temporary location and confirm the expected text history can be
   read. Do not treat this as a full restore test: attachment bytes and server/auth state are not in the repo.
4. Keep the normal complete `/data` backup and its restore procedure. Preserve the SSH key independently from the
   GitHub repo; a restore host needs a newly provisioned or deliberately restored credential.

## Acceptance criteria

1. The GitHub repository is private, initially empty, and dedicated to the intended share.
2. The deployed server authenticates using a repository-scoped SSH deploy key mounted read-only, with the key
   readable by UID `10001` and not exposed in logs or configuration values.
3. The server allows `github.com` through its configured remote-host allowlist and accepts the intended SSH URL.
4. A normal sync sends a text/code commit to the repository's `main` branch without force-pushing or resetting the
   share's existing head.
5. A verification clone contains expected text/code history and binary manifest metadata, but no attachment bytes,
   auth stores, upload state or other `/data` contents.
6. The operator retains the full `/data` backup and understands that GitHub's remote is not sufficient for complete
   recovery.
7. If the target is an existing selected v2 share, no unsupported state-file edit is performed; the required
   operator-command change is recorded as a prerequisite before continuing.

## Testing and validation

This is an operator procedure, not an application code change. Validate it with a disposable text file and a
private repository before relying on the remote for ongoing backups. Confirm the corresponding GitHub commit and
that the server continues to sync after restart. Do not use production notes or attachments as test data.

## Out of scope

- Replacing or weakening the complete `/data` backup and restore process.
- Uploading binary object storage, credentials, sessions, memberships, pending uploads or other server state to
  GitHub.
- Encrypting vault contents before GitHub receives them.
- Changing Marvin deployment files or configuring the live host from this repository.
- Adding a supported update command for an existing selected v2 share; track that separately if required.
