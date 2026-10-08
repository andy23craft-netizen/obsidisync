# ObsidiSync agent guide

ObsidiSync is a self-hosted Obsidian synchronization fork. The TypeScript Obsidian client synchronizes Markdown and attachments with a Rust server. The server maintains Git-backed text history, binary objects, upload/conflict/device metadata, and a folder-scoped WebDAV interface. This repository owns document synchronization and its access boundaries; Harmony consumes household documents, while Marvin owns host provisioning and deployment.

## Start here

- Read `README.md` and relevant repository documentation before making changes.
- Inspect `src/gitService.ts` for client endpoint construction and sync state.
- Inspect `rust-server/src/auth.rs` and `rust-server/src/http.rs` for authentication and routing.
- Inspect `rust-server/src/vault.rs` for storage, history, and metadata.
- Inspect `rust-server/src/webdav.rs` and `rust-server/src/device_passwords.rs` for WebDAV grants and credential handling.
- Confirm these paths and their current behavior in the working tree; they are pointers from an October 2026 architecture review, not immutable contracts.

## Engineering context and decision-making

This is personal, self-hosted hobby software, maintained by one developer/operator for a very small household user base. Prefer solutions that one person can understand, inspect, test, deploy, and recover.

- Preserve irreplaceable notes, attachments, history, credentials, and household privacy.
- Favor simple, explicit safety boundaries over elaborate infrastructure.
- Brief planned downtime is acceptable; silent data loss, unauthorized disclosure, and irreversible corruption are not.
- Prefer fail-closed behavior with actionable diagnostics and manual recovery for rare exceptional failures.
- Automate common, repetitive, or error-prone work; avoid enterprise-scale availability, orchestration, and approval machinery without a concrete need.
- Evaluate designs by realistic household risks, operational complexity, and long-term maintenance cost.
- Ask for a product decision when alternatives have meaningfully different privacy, data-loss, UX, or migration consequences; otherwise make the smallest defensible implementation choice.
- Do not reopen settled decisions without a concrete contradiction, safety issue, or changed requirement.

## Current architecture (verify before relying on it)

- Normal v1 API endpoints use `/v1/users/{user}/vaults/{vault}` and require the authenticated user to match the URL user namespace.
- Server vault storage is currently organized under `data/users/{user}/vaults/{vault}/`, with a Git repository and associated binary/upload/state data.
- Multiple vault slugs per user are supported, but two users cannot currently share one server-side vault merely by choosing the same slug.
- Each local Obsidian vault currently has one configured remote vault, server head, manifest, and sync state.
- Authentication includes OIDC, a single-user built-in password mode, and a development token mode. Do not mistake the single-user password mode for a multi-account system; never use development-token mode as a household production authentication design.
- WebDAV uses device passwords scoped to a particular user, vault, and folder, not ordinary bearer sessions. Its existing folder-scoping is not a general folder ACL system for the main sync API.
- The server has Git-based history and deleted-file recoverability; do not assume it has a separate trash or full-text search subsystem.

## Architectural direction (planned, not implemented)

The intended sharing model is **independently stored server-side shares with explicit user membership**:

- `andy-private`: Andy only.
- `liz-private`: Liz only.
- `harmony`: Andy and Liz.

A share, **not a folder path**, is the authorization and storage boundary. Use stable opaque share IDs for internal identity and storage; human-readable names are labels, not security identifiers. The planned model replaces user-owned vault authorization with share membership. Do not implement folder-level ACLs as the primary privacy mechanism.

### Non-negotiable privacy invariants

- Authenticate the principal, resolve the share, and verify membership/capability **before** exposing content or metadata.
- Unauthorized shares must not be enumerable. Ordinary callers should not be able to distinguish an inaccessible share from a nonexistent one through share-specific responses (normally return `404`).
- Prevent unauthorized access to filenames, listings, Markdown, attachments, byte ranges, Git revisions, deleted-file history, blobs, device records, upload state, conflicts, activity, and metadata.
- Check authorization consistently across the primary API, WebDAV, compatibility endpoints, and future diagnostics/admin surfaces.
- Keep Git history, binary storage, conflict state, and device state isolated by share. A private file must not enter a shared history merely because its current path is hidden.
- Do not treat client-side filtering, hidden folders, or a shared Git remote as access control.
- Bind WebDAV/device credentials to authorized shares and appropriately scoped folders/capabilities; prevent traversal and cross-share `MOVE`/`COPY` bypasses.
- A user losing access must not receive subsequent share data. Document that previously synchronized local copies cannot be remotely erased with a security guarantee.
- Treat external remotes, backups, server administrators, and compromised endpoints as separate trust boundaries; do not claim share membership provides encryption or protection against those actors.

### Target user experience and sequencing

First deliver a correct server-side share/membership model, client share selection, and safe migration. Separate Obsidian vaults are an acceptable **interim** experience. The **eventual product goal** is a composite local Obsidian vault with independently authorized remote shares mounted under local prefixes, e.g. `Personal/` and `Harmony/`, so each household member sees private and shared notes together.

Composite sync must keep separate heads, manifests, conflicts, recovery decisions, and path routing for each share. Treat cross-share moves as copy/import plus an explicitly confirmed delete, not an ordinary atomic rename. Consider links, attachments, root `.obsidian` configuration, mobile behavior, and failure recovery. Do not weaken server isolation to simplify the client UX.

A small local multi-user password account store is a candidate for this household; OIDC must remain supported, but do not assume deploying an additional identity provider is required. Research and decide authentication changes explicitly before implementation.

## Repository and workspace rules

- The canonical development environment is Ubuntu under WSL, in `~/Projects/obsidisync`. Run tests and package commands there, not via Windows UNC paths, unless testing Windows-specific behavior.
- Inspect existing dependency manifests and project scripts before selecting install, build, lint, or test commands. Do not invent commands or install dependencies globally.
- `rg` is not installed in the established environment; use `grep`, `find`, and other available Unix tools.
- Read-only Git inspection is allowed. Do not stage, unstage, commit, push, pull, reset, checkout, remove, or stash changes without explicit user authorization.
- Preserve unrelated working-tree changes; a dirty tree alone is not a blocker. Use disposable fixtures/worktrees for destructive tests.
- Write only in this repository unless cross-repository work is explicitly authorized. Read Harmony or Marvin interfaces when needed, but do not silently change their code or deployment.
- Use `apply_patch` for edits when available; keep changes focused and reviewable.
- Keep prose around 120 characters per line where practical, use straight quotes and ASCII punctuation, and end text files with a newline.
- Prefer documentation of verified current behavior; mark proposed architecture and future tickets clearly.
- If repository-local `.agents` skills exist, inspect and follow the relevant skill when requested. Do not assume Marvin's skills are installed here.

## Implementation and testing discipline

- For architectural, security, migration, or sync-protocol changes: investigate and propose a design before implementation unless the user explicitly authorizes coding.
- Trace changes end-to-end: client config and sync state, Rust handlers, authorization, vault/share storage, Git history, binary attachments, WebDAV, and compatibility routes as applicable.
- Protect existing v1 data. Design migrations with backups, consistency checks, explicit operator steps, and a verified rollback/recovery plan. Do not silently retarget device passwords or reset client sync state.
- Never allow a migration or initial sync to silently delete, overwrite, or expose existing user data. Require reconciliation where state is uncertain.
- Include positive and negative authorization tests: inaccessible share listing, direct content requests, historical revisions, blobs, metadata, upload/device credentials, WebDAV `PROPFIND`, traversal, and cross-share operations.
- Exercise sync conflicts, concurrent edits, partial uploads, restart/retry behavior, and binary attachments when affected.
- Use focused tests during development and the broader relevant suites before claiming completion. Syntax checks alone do not validate changed behavior.
- Keep API documentation, configuration examples, migration instructions, and operator runbooks aligned with implemented behavior.
- Distinguish implemented, locally tested, fixture-tested, deployed, and live-verified. Do not infer live Marvin state from repository contents.
- Never print or commit passwords, tokens, private notes, backup contents, or live application data.

## Boundaries with other household projects

- **ObsidiSync** owns transport, document storage/synchronization, share authorization, and document history. It should not become the grocery, recipe, task, or workout business-logic engine.
- **Harmony** owns household-facing workflows, document interpretation, task/grocery/recipe semantics, calendar directives, and notifications. It should consume authorized Markdown and attachments through a defined interface.
- **Marvin** owns provisioning, deployment, host networking, TLS/ingress, backups, and operational recovery. ObsidiSync application changes must not silently modify host configuration.
- **Shade** owns the library catalog; Kinbote bridges household hardware/services where applicable.

Favor ordinary, portable Markdown and attachments. Do not introduce plugin-specific document formats or server-side transformations merely because an Obsidian plugin exists. Changes to document schemas or parser behavior require coordination with Harmony's consumers.

## Reporting expectations

For substantial work, summarize: inspected current behavior; decision and rationale; changed files; tests and exact outcomes; data/privacy implications; migration/deployment actions required; remaining risks; and whether live behavior was actually verified. Do not present a research recommendation as an implemented feature.
