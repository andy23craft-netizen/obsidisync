# Plan Feature

Create or update an implementation-ready feature ticket based on a requested change and the current state of the codebase.

The feature ticket describes **remaining work required to implement the requested behavior**. It is not a historical record, changelog, implementation journal, or record of previous decisions.

## Inputs

The invoking prompt should provide:

* The path of the feature document to create or update, typically `docs/FEAT-XX_short-summary.md`.
* A description of the requested feature or behavioral change.
* Any additional files, requirements, constraints, or context that should be considered.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

## Goal

Produce a feature document that allows a competent engineer to understand:

1. What problem is being solved.
2. What behavior is desired.
3. How the relevant system currently works.
4. What is known versus assumed or unresolved.
5. What parts of the codebase are affected.
6. What implementation approach is recommended.
7. What observable behavior the human should verify after implementation.

The document should contain enough information to implement the feature without requiring the implementer to invent product requirements or make unresolved architectural decisions.

Do not implement the feature as part of this skill.

## Process

### 1. Understand the Request

Identify the underlying problem and desired behavior before designing a solution.

Do not immediately translate the user's requested behavior into code changes.

Separate:

* explicit requirements from the invoking prompt;
* behavior implied by existing system conventions;
* implementation choices;
* assumptions;
* unresolved questions.

Do not invent requirements.

When the request describes a proposed implementation rather than a desired behavior, determine whether the proposal is itself a requirement or merely one possible way to achieve the requested outcome.

### 2. Investigate the Current Codebase

Inspect the relevant portions of the codebase before proposing implementation changes.

Trace the existing behavior far enough to understand the feature in context. Depending on the feature, this may include:

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
* adjacent implementations of similar behavior.

Prefer established project conventions and existing abstractions unless the feature provides a reason to depart from them.

Do not describe a file or component as needing modification solely because its name suggests that it is relevant. Establish its role by inspecting the code.

### 3. Define the Problem

State the problem independently from the proposed implementation.

The problem statement should explain what capability is missing, what behavior is incorrect or insufficient, or what new behavior is required.

Prefer observable system or user behavior over implementation language.

### 4. Establish Knowns, Assumptions, and Unknowns

Clearly distinguish between:

**Requirements**
: Behavior explicitly required by the request or unambiguously established by repository context.

**Constraints**
: Existing architectural, compatibility, security, API, dependency, or repository constraints that limit the solution space.

**Assumptions**
: Things believed to be true or reasonable but not established as requirements.

**Open Questions**
: Product or architectural decisions that must be resolved before implementation can proceed safely.

Do not disguise assumptions as requirements.

Do not manufacture open questions for ordinary implementation details that a competent engineer can resolve using existing code conventions and engineering judgment.

An open question should generally be included only when different reasonable answers would produce meaningfully different externally observable behavior, architecture, data representation, compatibility, security characteristics, or scope.

### 5. Design the Implementation

Once the problem and relevant current behavior are understood, propose an implementation.

When multiple approaches would satisfy the requirements, choose the maintainable option: clear
ownership, reuse of existing patterns, minimal unnecessary indirection, and designs a later
engineer can change safely.

Prefer the smallest *maintainable* coherent change that satisfies the requirements and fits the
existing architecture. Prefer a slightly larger change that introduces or extends a reusable
primitive, removes duplication, or aligns with an established pattern over a smaller brittle
special-case. Speculative abstractions for hypothetical future needs remain forbidden.

Note architectural ownership and reuse opportunities rather than describing only a local patch when
that local patch would create known maintainability debt.

For each affected file or component, explain:

* why it is affected;
* what should change;
* important interactions with other components;
* any non-obvious constraints or edge cases.

Be specific enough to guide implementation without unnecessarily prescribing incidental coding details.

Do not include speculative changes that are not needed to satisfy the feature.

Do not create abstractions, configuration, extension points, or generalized infrastructure solely for hypothetical future requirements unless the requested feature requires them.

Do not recommend metric-only refactors (e.g., break up a function solely to reduce cyclomatic
complexity) unless that change is independently justified by readability or responsibility
boundaries. Static maintainability metrics may inform human review but must not be treated as goals
to optimize in the ticket.

Do not add ceremonial maintainability scorecards or mandatory maintainability metric sections to the
feature document. Encode maintainability in the proposed approach itself so a later
`implement-ticket` run inherits the priority.

### 6. Define Manual Verification Criteria

Describe the observable outcomes that a human should verify after implementation.

These are **manual verification criteria**, not instructions for the LLM to perform verification.

Focus on behavior rather than implementation details.

Where relevant, include:

* normal behavior;
* important boundary conditions;
* error behavior;
* interactions with existing behavior that must remain unchanged.

Do not claim that the feature has been verified.

## Feature Document Structure

Use the following structure where applicable.

Sections that genuinely do not apply may be omitted. Do not create empty or ceremonial sections.

```markdown
# FEAT-XX: Short Summary

## Problem

Describe the problem or missing capability independently of the proposed implementation.

## Desired Behavior

Describe the observable behavior that should be true when the feature is complete.

## Current Behavior

Summarize how the relevant system currently behaves and the portions of the existing implementation that matter to this feature.

## Requirements

- Concrete requirement.
- Concrete requirement.

## Non-Goals

- Explicitly excluded behavior or scope.

Omit this section when the boundaries are already obvious and no useful exclusions need to be recorded.

## Constraints

- Relevant architectural, compatibility, security, API, or repository constraint.

## Assumptions

- Assumption that affects the proposed solution.

Omit this section if there are no meaningful assumptions.

## Open Questions

- Decision or missing information that should be resolved before implementation.

Omit this section when there are no blocking questions.

## Proposed Implementation

Describe the recommended technical approach and how the affected parts of the system work together.

### `path/to/file.ext`

Explain why this file is affected and what should change.

### `path/to/another-file.ext`

Explain why this file is affected and what should change.

## Manual Verification

Describe the behavior a human should verify after implementation.

- Verification scenario.
- Expected observable result.
```

The exact organization of **Proposed Implementation** may vary when grouping by subsystem, component, or responsibility communicates the change more clearly than grouping strictly by file.

## Writing Guidelines

Keep the document focused on **current understanding and remaining work**.

Prefer concise explanations with concrete references to the codebase.

When writing instructions for how to write or edit code, keep those instructions readable and
communicate maintainability expectations clearly enough that a later agent following only the ticket
inherits the priority: functionality first, then maintainability/readability, then incidental
preferences.

Use file paths, symbols, APIs, configuration keys, database objects, and other identifiers when they materially help the implementer locate or understand the relevant code.

Do not turn the feature document into a line-by-line implementation recipe when ordinary implementation decisions can safely be left to the engineer.

Do not include:

* a history of how the plan evolved;
* superseded requirements;
* rejected approaches unless understanding the rejection remains necessary;
* completed work that no longer affects remaining implementation;
* conversational commentary;
* speculative future enhancements;
* generic software-engineering advice;
* information already adequately established by repository-level instructions unless it directly affects this feature.

When new information supersedes old information, rewrite the affected section so that the document describes the current understanding. Do not append correction notes or preserve obsolete states for historical purposes.

## Readiness

A feature document is implementation-ready when a competent engineer can implement it using the document, repository instructions, existing codebase, and ordinary engineering judgment **without inventing product requirements or resolving significant unstated architectural decisions**.

The feature document does not need to prescribe every implementation detail.

If unresolved questions prevent implementation readiness, document them explicitly rather than guessing.

If uncertainty can reasonably be resolved from existing code, repository conventions, or straightforward investigation, investigate it rather than turning it into an open question.

## Output

Create or update the feature document at the path specified by the invoking prompt.

Do not implement the feature.

Do not perform post-implementation verification.

Do not modify unrelated files.
