# GitHub tag releases

The GitHub workflow in `.github/workflows/plugin-ci.yml` publishes releases on pushes of `v*` tags.
A branch push runs CI but does not publish a container. This direct GitHub procedure is separate from the
Forgejo semantic-release path described in the project README; use one release path for a given version.

Choose a fresh semantic version after inspecting existing release tags. A minor release after `v0.15.1` is
`v0.16.0`. Keep `package.json`, the root package entries in `package-lock.json`, `manifest.json`, and the server's
`Cargo.toml`/root package in `Cargo.lock` aligned. The server reports its Cargo package version in server info.

After reviewing changes, run these commands in Ubuntu/WSL from `~/Projects/obsidisync`:

```bash
git status --short
git diff --check
git add -A
git commit -m "chore: prepare v0.16.0 release"
git tag -a v0.16.0 -m "ObsidiSync v0.16.0"
git push --atomic origin main refs/tags/v0.16.0
```

Review all listed changes before staging; `git add -A` includes the documentation moves/deletions.
These commands assume `main` and the configured GitHub `origin`. Never move/reuse a published release tag.

The tag workflow tests/builds the plugin and Rust server, builds the image on a native ARM64 runner, smoke-tests
it over loopback, publishes `ghcr.io/andy23craft-netizen/obsidisync:v0.16.0`, verifies its commit provenance and
anonymous digest pull, then publishes the GitHub release and plugin assets. Wait for the entire workflow to succeed.

Copy the complete `ghcr.io/andy23craft-netizen/obsidisync@sha256:...` reference from the GitHub release notes.
The same reference is recorded in the `obsidisync-v0.16.0-arm64-evidence` workflow artifact. Pin this digest in
Marvin's deployment configuration; it identifies the exact built image. No `latest` tag is published.
The image targets `linux/arm64`. Publication does not deploy it at home.

For a later release, substitute its version in all commands and artifact names. Deployment of existing data
requires the separately authorized [migration/recovery procedure](../runbook/SHARE_STORAGE_AND_MIGRATION.md).
Deploy a server advertising `nativeSyncConditionalCreate` before using
[cross-mount import](../runbook/CROSS_MOUNT_IMPORT.md); preserve schema 2 client settings and import recovery copies
when considering client rollback.
