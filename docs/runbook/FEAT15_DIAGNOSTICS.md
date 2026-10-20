# FEAT-15 review and operator checks

Review date: 2026-10-19. Source inspected: `main`, commit `34d6b95`, including implementation `2feebeb`.
This is local review evidence, not verification of the deployed server or affected iPhone.

## Findings

- The stale automatic barrier fix and bulk download control are implemented. The iPhone validation incident is
  still unresolved; the reproduced barrier defect does not establish its cause.
- Acceptance criteria 6 and 10 remain incomplete: `validateComposite` still throws a generic error, and
  `onload` awaits `loadSettings` before registering the settings tab. Invalid composite state therefore prevents
  the promised in-plugin recovery view from becoming available. Stable reason codes are also absent.
  The ticket's "implementation complete" wording should not be read as completion of these requirements.
- The two-client harness restores JSON into `GitService`; it does not run the actual plugin loader or BRAT,
  emulate iOS suspension, renew an expired login, or prove an in-place upgrade of the affected phone state.
  Those remain separate device acceptance checks.

## Preserve evidence before testing the affected device

1. Stop editing and close Obsidian on the affected phone. Record the installed plugin version and exact error text.
2. Make a protected complete vault backup including hidden `.obsidian` and `.obsidian-git-sync` directories.
   Verify the backup includes `.obsidian/plugins/ios-git-sync/data.json`, `main.js` and `manifest.json`, plus
   attachments and recovery backups. Use your established device backup/export method. Do not assume a Files
   copy includes hidden directories; if it does not, stop and arrange a complete backup first.
3. Keep this original unchanged. Settings contain credentials, identities, paths and recovery state. Do not paste
   `data.json`, auth stores, full console logs or notes into chat. Do not delete settings, recreate mounts,
   force-upload, use bulk replacement, or downgrade to bypass validation.
4. If unchanged-launch reproduction is needed, reopen once after the verified backup and record whether the same
   error occurs. Stop on that error. The current UI cannot identify the rejected invariant safely; a local
   validator diagnostic improvement or a trusted local debugging session is needed before a targeted repair.
   No production state repair is established by this review.

## Device acceptance after valid startup

Use disposable notes within one already initialized mount. If validation still fails, do not perform these steps.

1. Update through the normal BRAT/manual workflow while preserving `data.json`. Compare mount count, prefixes,
   selected server/account, initialized status, writable choices and pending recovery counts before and after.
   Keep identifiers and detailed settings local. An update alone must not request onboarding or write consent.
2. Create one test Markdown note and one small attachment on the computer. Sync there, then sync on the phone.
   Expect both to appear without approval. Edit the note on the phone, sync both, then delete the disposable note
   on the phone and sync both again. Expect the edit and deletion on the computer.
3. Close/reopen both clients and repeat in the other direction. Confirm no repeated decisions or startup error.
4. On a download-only mount, repeat remote additions/edits/deletions; expect downloads without uploads.
5. For a disposable conflict test, take both clients offline, edit the same disposable note differently, then
   reconnect and sync. Expect recoverable conflict handling, not silent replacement. Preserve both versions.
6. At the next natural expired-login event, renew or log in with the same verified identity. Confirm setup and
   recovery counts remain. Do not revoke production sessions or change identity merely to force this test.
7. Bulk recovery is an explicit replacement action, not a diagnostic. Test it only on disposable reconciliation
   records: verify its captured count, local backup, remote deletion behavior and applied/skipped/failed totals.

Return only plugin versions, pass/fail per step, the exact generic error text and whether it recurs unchanged.
Do not return private filenames, mount labels, share IDs, tokens, screenshots of notes or raw settings.

## Optional server check (operator only)

The startup validator runs locally before sync, so server access is not currently needed to diagnose that error.
If normal sync fails after valid startup, the operator can check the public capability endpoint from a trusted
machine. Replace the example URL; this sends no credentials and discards the response body:

```bash
curl --silent --show-error --connect-timeout 10 --max-time 20 \
  --output /dev/null --write-out 'server-info HTTP %{http_code}\n' \
  https://YOUR-SYNC-HOST/v1/server/info
```

Return only the HTTP status or a sanitized TLS/connection error. Do not use verbose curl, paste authorization
headers, dump container environment variables or expose server data. A `200` proves endpoint reachability only,
not authentication, membership or document sync. No deployment, offline admin command or migration is requested.

## Reproduce automated diagnostics in WSL

Run in Ubuntu, in `~/Projects/obsidisync`, with the existing project Node/npm and Cargo toolchains on PATH:

```bash
cd ~/Projects/obsidisync
npm ci
npm run test:plugin
npm run build:plugin
npm run test:server
npm run test:e2e
```

The e2e harness uses synthetic data under `.tmp-tests/e2e` and a loopback server on port 18787. It replaces its
own fixture directories. Do not point it at household vaults or a deployed data directory. Plugin builds regenerate
`main.js`; inspect Git status afterward. Automated success does not close the device incident.
