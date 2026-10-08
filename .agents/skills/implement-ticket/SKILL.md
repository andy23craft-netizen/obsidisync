# Implement Ticket

Implement the remaining work described by an implementation-ready feature or bug ticket.

The ticket defines the intended scope and desired outcome. The current codebase defines the implementation context. Repository instructions and established conventions govern how the change should be made.

This skill modifies the codebase. It does not redefine requirements, perform final human verification, or refresh/delete the ticket after implementation.

## Inputs

The invoking prompt should provide:

* The path of the feature or bug ticket to implement.
* Any additional implementation-specific context or constraints.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

## Goal

Implement the complete remaining work described by the ticket such that:

1. The implementation satisfies the ticket's requirements and desired behavior.
2. Bug fixes address the established root cause and proposed remediation.
3. Changes fit the current architecture and established repository conventions.
4. Automated tests are added or updated where appropriate.
5. Unrelated behavior is not changed.
6. The implementation does not silently invent product requirements or significant architectural decisions.
7. The ticket itself remains unchanged for later reconciliation by the appropriate workflow.

When choosing among designs that all satisfy the requirements, use this priority:

1. Satisfy required functionality and preserve required existing behavior.
2. Maximize maintainability and readability of the resulting code.
3. Only then optimize for incidental preferences.

Prefer designs a competent engineer can understand and change later: clear ownership, coherent
abstractions, minimal unnecessary indirection, and reuse of existing patterns. Prefer a slightly
larger change that introduces or extends a reusable primitive, removes duplication, or aligns with
an established pattern over a smaller brittle special-case. Speculative abstractions for
hypothetical future needs remain forbidden. Maintainability is not a license for unrelated cleanup,
modernization, or architecture redesign outside the ticket.

Static maintainability metrics (e.g., cyclomatic complexity, cognitive complexity, Sonar-style
scores) may inform human review but must not be used as autonomous success criteria or as goals to
optimize. Do not break up cohesive logic solely to appease a metric.

Implement the ticket completely unless a genuine blocker prevents responsible implementation.

## Supported Ticket Types

### Feature Tickets

A feature ticket should provide enough information to understand:

* the problem;
* desired behavior;
* requirements;
* constraints;
* relevant current behavior;
* proposed implementation;
* affected components;
* manual verification criteria.

Implement the remaining work necessary to satisfy the feature's requirements and desired behavior.

### Bug Tickets

A bug ticket should have progressed far enough through diagnosis to contain:

* an established root cause;
* a justified proposed resolution;
* sufficient implementation detail to remediate the defect responsibly.

Implement the proposed remediation in a way that addresses the established root cause.

Do not implement speculative fixes for a bug that is still primarily in the diagnostic or hypothesis stage.

If additional diagnosis is necessary before a responsible fix can be selected, stop and report the blocker rather than guessing.

## Process

### 1. Read the Entire Ticket

Read the complete ticket before modifying code.

Understand:

* what problem is being solved;
* what behavior is required;
* what work remains;
* relevant constraints;
* assumptions;
* dependencies;
* open questions;
* the proposed implementation or resolution;
* affected components;
* manual verification criteria.

Do not begin implementation after reading only the first actionable change.

Treat the ticket as a coherent unit of work.

### 2. Read Repository Instructions

Consider applicable repository-level and scoped instructions before making changes.

Follow:

* `AGENTS.md`;
* applicable scoped rule files;
* repository conventions;
* build and test instructions;
* architectural boundaries;
* generated-code rules;
* dependency-management conventions;
* formatting and linting conventions.

More specific repository instructions take precedence over generic implementation preferences in this skill.

### 3. Inspect the Current Codebase

Reinspect the relevant current code before modifying it.

Do not assume that every implementation detail in the ticket still matches the repository exactly.

The codebase may have changed since the ticket was written.

Inspect enough surrounding code to understand:

* current control flow;
* current data flow;
* relevant interfaces and abstractions;
* existing conventions;
* affected call sites;
* tests;
* adjacent behavior that must remain intact.

Prefer the current repository's established abstractions and patterns.

If minor differences exist between the ticket's implementation description and the current codebase, adapt the implementation using ordinary engineering judgment while preserving the ticket's requirements and intent.

If the difference materially changes the planned behavior, architecture, scope, compatibility, or security characteristics, treat it as a potential blocker rather than silently redesigning the ticket.

### 4. Confirm Implementation Readiness

Before making substantive changes, determine whether the ticket is sufficiently ready to implement.

Do not repeat a full readiness-check workflow when the ticket is clearly actionable.

Stop when implementation would require inventing a material decision such as:

* externally observable behavior;
* product requirements;
* authorization or security policy;
* ownership of a significant architectural responsibility;
* incompatible data-model choices;
* public API semantics;
* scope boundaries.

Do not stop for ordinary engineering decisions such as:

* local variable names;
* private helper decomposition;
* equivalent language constructs;
* small refactorings;
* straightforward use of established repository patterns;
* implementation details clearly implied by surrounding code.

The standard is:

> Can a competent engineer resolve this decision using the ticket, current codebase, repository conventions, and ordinary engineering judgment?

If yes, proceed.

### 5. Implement the Complete Ticket

Implement all remaining work described by the ticket.

Do not stop after completing the first obvious file or code path.

Track the ticket's requirements throughout implementation and ensure that each is addressed where applicable.

For feature tickets, implement the behavior necessary to satisfy the requirements and desired behavior.

For bug tickets, implement the changes necessary to address the established root cause and proposed resolution.

Changes may span multiple technical layers when the behavior requires them.

For example, one feature may legitimately require coordinated changes to:

* persistence;
* domain logic;
* APIs;
* frontend behavior;
* configuration;
* automated tests.

Do not artificially limit implementation to a single layer merely because the ticket is described primarily in terms of one component.

### 6. Exercise Engineering Judgment

The ticket describes what needs to be accomplished and may recommend how.

It is not necessarily a line-by-line coding prescription.

Use ordinary engineering judgment for incidental implementation details.

Prefer:

* existing abstractions;
* existing architectural patterns;
* existing libraries and dependencies;
* established naming conventions;
* existing error-handling approaches;
* the smallest *maintainable* coherent implementation that satisfies the ticket.

"Smallest" means avoiding unnecessary scope, not preferring a brittle local special-case over a
small reusable change that removes duplication or aligns with an established pattern.

Do not follow a stale implementation detail mechanically when the current codebase provides an obviously equivalent established pattern.

At the same time, do not reinterpret the ticket merely because you prefer a different design.

### 7. Keep Scope Controlled

Make changes necessary to implement the ticket correctly.

Small supporting refactors are acceptable when they are necessary to implement the change safely or cleanly.

Do not expand the work into unrelated:

* cleanup;
* refactoring;
* modernization;
* dependency upgrades;
* formatting changes;
* architecture redesign;
* speculative future functionality.

When encountering unrelated defects, do not silently fix them unless they prevent implementation of the ticket.

If an unrelated issue materially blocks the requested implementation, report it.

### 8. Handle Unexpected Discoveries

Implementation may reveal information that was not apparent during planning.

When new information is compatible with the ticket and can be handled through ordinary engineering judgment, adapt the implementation and continue.

When new information invalidates a material assumption or exposes an unresolved decision, stop before making an arbitrary choice.

Examples include discovering that:

* the requested behavior conflicts with another explicit requirement;
* a supposedly internal change would alter a public contract;
* the proposed data representation cannot support a required behavior;
* authorization behavior is unspecified and materially affected;
* another system actually owns the responsibility the ticket proposes changing;
* a required dependency does not exist and introducing one would constitute a significant architectural choice.

Report:

* what was discovered;
* why it blocks responsible implementation;
* what decision or clarification is needed;
* which portions of the ticket, if any, were implemented before the blocker was discovered.

Do not silently rewrite the requirement to make implementation easier.

### 9. Preserve Existing Behavior

Unless the ticket explicitly changes existing behavior, preserve it.

Pay particular attention to:

* public APIs;
* persistence formats;
* error semantics;
* authorization;
* configuration;
* backward compatibility;
* adjacent workflows;
* shared components.

Do not interpret absence from the ticket as permission to change unrelated behavior.

### 10. Add or Update Automated Tests

Add or update automated tests when appropriate for the repository and change being implemented.

Tests should primarily protect the behavior introduced or corrected by the ticket.

For features, tests should cover important new behavior and relevant edge cases when practical.

For bugs, prefer adding a regression test that would fail because of the diagnosed defect and pass after the remediation, when the behavior is reasonably testable.

Do not create tests merely to increase coverage metrics.

Do not rewrite unrelated tests unless required by an intentional behavior change.

Follow existing repository testing conventions.

### 11. Run Relevant Automated Checks

Run the relevant automated checks available in the repository when practical.

Depending on the project, these may include:

* targeted tests;
* broader test suites;
* type checking;
* compilation;
* linting;
* formatting checks;
* static analysis.

Prefer targeted checks during implementation and broader appropriate checks once the change is coherent.

If a full check is prohibitively expensive or unavailable, run the most relevant practical subset.

If an automated check fails:

1. Determine whether the failure was caused by the implementation.
2. Fix failures caused by the implementation.
3. Do not silently modify unrelated behavior merely to make an unrelated pre-existing failure pass.
4. Report relevant pre-existing or unresolved failures in the final summary.

Passing automated checks does not constitute final feature or bug verification.

### 12. Review Maintainability

Before declaring the ticket done, perform a holistic maintainability review of the changes just
made. Inspect nearby call sites and abstractions enough to avoid tunnel-vision duplicates.

Check for at least:

* unnecessary new abstractions, layers, interfaces, configuration, or extension points without a
  present requirement;
* duplicate or near-duplicate types, helpers, or workflows;
* brittle special-cases that a small reusable primitive would better address;
* redundant operations across layers that a shared concept or field would remove;
* local changes that ignore nearby established patterns;
* naming, structure, and decomposition that a later reader can follow without tribal knowledge
  beyond what the repository already requires.

When a small in-scope adjustment would improve maintainability without changing required behavior or
expanding into unrelated redesign, make that adjustment before finishing.

Do not treat static complexity or maintainability metrics as acceptance criteria for this review.
Do not use the review as a pretext for unrelated cleanup or speculative redesign.

### 13. Do Not Perform Manual Verification

The human is responsible for final feature and bug verification.

Do not perform the ticket's manual verification workflow unless the invoking prompt explicitly asks for it separately.

Do not claim:

* that the feature has been manually verified;
* that the bug has been confirmed resolved in actual use;
* that acceptance testing has passed;
* that user-visible behavior has been validated merely because automated tests pass.

Automated tests and build checks are part of implementation quality control, not a substitute for human verification.

### 14. Do Not Refresh the Ticket

Do not modify, shrink, or delete the feature or bug ticket as part of implementation.

In particular, do not:

* remove completed requirements;
* mark sections complete;
* rewrite the proposed implementation to describe what was done;
* delete completed sections;
* delete the ticket.

Ticket reconciliation belongs to the `refresh-ticket` workflow.

Keeping implementation and refresh separate makes it possible to compare the ticket against the resulting codebase after implementation.

## Ticket Authority

Use the following hierarchy when deciding how to proceed:

1. Explicit requirements and clarifications supplied by the invoking user.
2. The ticket's requirements and desired behavior.
3. Applicable repository instructions and architectural constraints.
4. The current codebase and established conventions.
5. The ticket's proposed implementation details.
6. Ordinary engineering judgment.

This hierarchy does not authorize violating repository constraints to satisfy an impossible requirement.

When higher-level requirements conflict with lower-level implementation guidance, preserve the higher-level intent and adapt the implementation where the decision is non-material.

When requirements themselves conflict or cannot be implemented without a material decision, stop and report the blocker.

## Handling Stale Ticket Details

A ticket may reference:

* renamed files;
* moved symbols;
* refactored abstractions;
* implementation details that have since changed.

Do not stop merely because such details are stale.

Resolve straightforward drift from the current codebase and continue when the intended change remains clear.

For example, if a ticket says:

> Update `OldPatientService.GetPatient()`.

and the codebase has straightforwardly renamed that service to `PatientService`, use the current implementation.

However, if `OldPatientService` was replaced by an architecture in which responsibility is split between several services and choosing where the feature belongs is a significant design decision, do not arbitrarily choose one.

Distinguish **mechanical drift** from **semantic drift**.

### Mechanical Drift

Examples:

* renamed symbol;
* moved file;
* equivalent helper extracted;
* changed test location;
* straightforward signature change.

Adapt and continue.

### Semantic Drift

Examples:

* changed architectural ownership;
* changed public contract;
* changed data model;
* changed security model;
* removed capability on which the plan depends;
* new behavior that conflicts with a requirement.

Evaluate whether ordinary engineering judgment is sufficient.

If not, report a blocker.

## Partial Implementation

Avoid leaving a ticket partially implemented when the remaining work can reasonably be completed.

If a genuine blocker appears after some changes have already been made:

* leave completed changes only when they are coherent and safe on their own;
* avoid leaving the repository knowingly broken;
* revert or adjust incomplete work when necessary to restore coherence;
* report precisely what was and was not implemented.

Do not represent a partially implemented ticket as complete.

## Durable Knowledge

Implementation may reveal durable information that would be useful beyond this ticket.

Examples include:

* architectural ownership boundaries;
* non-obvious repository conventions;
* integration constraints;
* important invariants;
* operational requirements.

Do not modify `AGENTS.md`, ADRs, or other permanent documentation merely because such information was discovered unless the ticket or invoking prompt requires those changes.

When useful, mention potential documentation candidates in the final summary.

Be selective. Ordinary implementation details do not need promotion to permanent documentation.

## Output

Modify the codebase as necessary to implement the ticket.

Do not modify the ticket itself.

After implementation, provide a concise summary containing:

* what was implemented;
* important implementation decisions that were not already obvious from the ticket;
* automated tests or checks that were added or updated;
* automated checks that were run and their results;
* any relevant checks that could not be run;
* any remaining blockers or incomplete work;
* any durable repository knowledge that may deserve permanent documentation.

Do not provide a lengthy file-by-file narration when the changes are straightforward.

Do not claim that manual verification has been performed.

If implementation is blocked before changes are made, report the blocker and the decision or information needed to proceed.

## Review Discipline

Implement the ticket, not an imagined better project.

Be complete without expanding scope.

Use engineering judgment without inventing product decisions.

Prefer existing architecture over unnecessary new abstractions.

Prefer a maintainable coherent change over a brittle minimal patch when both satisfy the
requirements.

Adapt to mechanical codebase drift without unnecessary escalation.

Escalate semantic drift when resolving it requires a material decision.

Address root causes rather than symptoms when implementing bug fixes.

Use automated tests and checks to catch implementation mistakes, but leave final behavioral verification to the human.

Do not optimize for static maintainability metrics as goals in themselves.

Do not modify the ticket merely because implementation is complete.

The central questions are:

> What changes are necessary to satisfy the ticket completely?

> Which implementation details can be resolved safely through existing code and ordinary engineering judgment?

> Has new information exposed a material decision that the ticket does not actually resolve?

> Is the resulting design readable and coherent for a later engineer or agent to change safely?

and:

> Can I leave the codebase in a coherent, maintainable state that is ready for the human to verify?
