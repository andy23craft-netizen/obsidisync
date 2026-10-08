# Refresh Ticket

Reconcile an existing feature or bug ticket with the current state of the codebase.

Tickets describe **current understanding and remaining work**. They are not historical records, changelogs, implementation journals, or records of how a solution evolved.

A refresh removes stale or completed content, updates information that no longer matches the codebase, and deletes the ticket when no implementation work remains.

This skill does not implement remaining work or perform feature/bug verification.

## Inputs

The invoking prompt should provide:

* The path of the feature or bug ticket to refresh.
* Any additional context that should be considered.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

## Goal

After refresh, the ticket should accurately answer:

> Given the current codebase, what work described by this ticket still remains?

The refreshed ticket should:

1. Accurately reflect the current codebase.
2. Remove work that has already been implemented.
3. Remove sections that are no longer relevant.
4. Update remaining work when implementation has changed the surrounding code or invalidated the original plan.
5. Preserve unresolved requirements, constraints, assumptions, questions, and diagnostics that remain relevant.
6. Avoid preserving obsolete information merely for historical context.
7. Be deleted when no implementation or remediation work remains.

## Process

### 1. Read the Entire Ticket

Understand the ticket as a whole before modifying it.

For a feature ticket, identify:

* the problem;
* desired behavior;
* requirements;
* non-goals;
* constraints;
* assumptions;
* open questions;
* proposed implementation;
* manual verification criteria.

For a bug ticket, identify:

* observed behavior;
* expected behavior;
* evidence;
* active hypotheses;
* diagnostic steps;
* established root cause, if any;
* proposed resolution;
* manual verification criteria.

Do not refresh individual sections independently without understanding their relationship to the overall ticket.

### 2. Inspect the Current Codebase

Inspect the relevant portions of the current codebase.

Determine which statements in the ticket are still accurate and which described changes have already been implemented.

Depending on the ticket, inspect relevant:

* entry points;
* call sites;
* interfaces and abstractions;
* domain models;
* API contracts;
* persistence;
* configuration;
* frontend state and components;
* error handling;
* tests;
* generated code;
* related implementations.

Do not assume that the ticket accurately describes the current codebase merely because it did so when originally written.

Do not assume that a change is unimplemented merely because the ticket still lists it.

### 3. Classify Ticket Content

For each substantive part of the ticket, classify it conceptually as one of:

**Still Current**
: The information remains accurate and relevant to remaining work.

**Implemented**
: The described implementation work is already present in the current codebase.

**Superseded**
: The information no longer accurately describes the codebase, requirements, or remaining implementation approach.

**No Longer Relevant**
: The information may still be true but is no longer useful for understanding or implementing the remaining work.

**Still Unresolved**
: The question, assumption, hypothesis, diagnostic step, or implementation work remains relevant and unresolved.

Use these classifications to guide the refresh. Do not add these labels to the ticket unless they are independently useful to the ticket's content.

### 4. Remove Completed Work

Remove requirements from the ticket's remaining-work description when the corresponding implementation work has been completed.

Remove proposed implementation steps that are already present in the codebase.

Remove affected-file entries when no remaining work applies to those files.

Remove entire sections when they no longer contain useful information.

Do not preserve completed work merely to document what was done.

The source code, version-control history, and permanent documentation are better sources for implementation history.

### 5. Update Stale Information

When remaining work is still required but the surrounding codebase has changed, rewrite the affected portions of the ticket to match the current codebase.

For example:

* update file paths;
* update symbol names;
* update control-flow descriptions;
* update API or data-model references;
* revise the proposed implementation when an earlier prerequisite has already been implemented;
* remove steps that are no longer necessary;
* adjust remaining steps to use abstractions introduced since the ticket was written.

When rewriting remaining work, preserve and strengthen maintainability-relevant guidance that is
still applicable. Remove guidance that would push the implementer toward obsolete local patches
after better abstractions now exist in the codebase. Prefer remaining-work descriptions that favor
reuse and clear ownership over brittle special-cases. Do not recommend metric-only refactors unless
independently justified by readability or responsibility boundaries.

Describe the **current state and current remaining work**.

Do not write historical transitions such as:

> Originally this used `OldService`, but that was replaced by `NewService`, so now...

Prefer:

> `NewService` owns this responsibility. Extend it to...

Preserve historical information only when it remains necessary to understand a current constraint or decision.

### 6. Preserve the Original Intent

Refreshing a ticket must not silently redefine the requested feature or bug fix.

Use the original problem, desired behavior, requirements, and subsequent explicit clarifications to determine what still remains.

Do not treat divergence between the current codebase and the ticket as evidence that the requirement has changed.

A requirement is complete when the required implementation is present, not merely when the codebase has evolved in a different direction.

If the current codebase contradicts a still-valid requirement, update the implementation plan rather than deleting the requirement.

### 7. Distinguish Implementation from Verification

This skill determines whether the implementation work described by the ticket appears to be present in the codebase.

It does **not** determine whether the feature or bug fix has been successfully verified.

Do not:

* perform manual feature verification;
* perform manual bug verification;
* claim that user-visible behavior has been confirmed;
* claim that the ticket has passed acceptance testing;
* infer successful verification merely because code or tests exist.

The human remains responsible for feature and bug verification.

A ticket may therefore have no remaining implementation work even though human verification has not yet occurred.

### 8. Refresh Manual Verification Criteria

When the ticket contains manual verification criteria, update them to reflect the remaining or newly implemented behavior.

Remove verification criteria that no longer correspond to the ticket's current requirements.

Do not remove useful verification criteria merely because the implementation appears complete.

If the ticket is being deleted because no implementation work remains, the verification criteria do not by themselves justify retaining the ticket.

Do not perform the verification.

## Feature Ticket Rules

For feature tickets, preserve the principles of the `plan-feature` workflow.

The refreshed document should describe only the current problem context and remaining implementation work.

Encode maintainability in remaining proposed work: functionality first, then
maintainability/readability, then incidental preferences. Do not invent ceremonial maintainability
scorecard sections.

Remove:

* completed requirements from the remaining-work description;
* implementation steps that have already been performed;
* obsolete assumptions;
* resolved open questions;
* affected files that no longer require changes;
* obsolete local-patch guidance that a newer shared abstraction has superseded.

Update:

* current behavior;
* remaining requirements;
* relevant constraints;
* assumptions that still matter;
* open questions that still block remaining work;
* proposed implementation;
* affected files;
* manual verification criteria.

If a partially implemented requirement still requires work, rewrite it to describe precisely what remains rather than preserving the original broader requirement as though none of it has been implemented.

## Bug Ticket Rules

For bug tickets, preserve the distinction between evidence, hypotheses, diagnostics, and established root cause.

Remove diagnostic steps that have already served their purpose and no longer need to be performed.

Remove hypotheses that have been disproven or made irrelevant by newer evidence.

Update active hypotheses in light of current evidence.

Do not preserve a chronological record of previous diagnostic theories.

If the root cause has been established, state the current root cause directly and remove obsolete diagnostic material unless additional diagnostics are still necessary.

If a proposed fix has already been implemented, remove that implementation work from the remaining-work description.

If additional remediation remains, rewrite the proposed resolution around what still needs to change.

Do not treat the presence of a plausible fix as proof that the bug has been resolved.

## Durable Knowledge

During refresh, implementation may reveal information that is useful beyond the lifetime of the ticket.

Examples include:

* important architectural ownership boundaries;
* non-obvious repository conventions;
* integration constraints;
* invariants future engineers need to know;
* operational requirements;
* durable API behavior.

Do not retain completed ticket content merely because it contains useful permanent knowledge.

Instead, identify durable knowledge that appears to belong in permanent repository documentation such as:

* `AGENTS.md`;
* architecture documentation;
* an ADR;
* API documentation;
* operational documentation;
* another repository-specific source of truth.

Do not automatically modify those documents unless explicitly requested.

Report potential documentation candidates after refreshing the ticket.

Be selective. Do not propose promoting ordinary implementation details or information already documented elsewhere.

## Deleting the Ticket

Delete the ticket when **no implementation or remediation work described by the ticket remains**.

Before deleting it, confirm that:

* all required implementation appears to be present in the current codebase;
* no unresolved implementation-affecting questions remain;
* no remaining diagnostic work is necessary to determine a bug's cause or remediation;
* no partial requirement still requires implementation.

Manual verification being outstanding does not, by itself, require retaining the ticket.

Do not keep an otherwise completed ticket solely as:

* historical documentation;
* a record of completed work;
* a verification checklist;
* evidence that the feature existed;
* a record of previous diagnostic steps.

If durable knowledge should be moved elsewhere, report that separately rather than retaining the completed ticket.

## Handling Uncertainty

Do not remove work merely because it appears likely to have been implemented.

Inspect the relevant code.

When it is genuinely unclear whether implementation remains, preserve the relevant requirement and explain the uncertainty rather than incorrectly deleting it.

Prefer resolving uncertainty through repository inspection.

Do not turn ordinary implementation details into open questions.

Do not perform manual verification to resolve uncertainty about runtime behavior.

## Output

If work remains:

1. Update the existing ticket in place.
2. Remove stale, completed, superseded, and irrelevant content.
3. Rewrite affected sections so the ticket describes the current state and remaining work.
4. Preserve the ticket's established structure where useful.
5. Report briefly that the ticket was refreshed and summarize the major remaining work.
6. Identify any durable knowledge that may belong in permanent repository documentation.

If no implementation or remediation work remains:

1. Delete the ticket.
2. Report briefly that it was deleted because no implementation work remains.
3. Make clear that deletion does not imply that human verification has been performed.
4. Identify any durable knowledge that may belong in permanent repository documentation.

Do not implement remaining work.

Do not perform feature or bug verification.

Do not modify unrelated files.

## Review Discipline

Be aggressive about removing obsolete content but conservative about declaring requirements complete without evidence in the codebase.

Do not preserve history for history's sake.

Do not rewrite accurate content merely to change wording.

Do not expand the scope of the ticket.

Do not introduce speculative improvements.

Do not convert completed implementation details into permanent documentation automatically.

Do not equate tests with human verification.

Do not equate code changes with changed requirements.

The central questions are:

> What work described by this ticket still remains given the current codebase?

and:

> Can everything else be removed without losing information necessary to complete that remaining work?
