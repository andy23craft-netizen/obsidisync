# Readiness Check

Evaluate whether a feature or plan document is ready for implementation.

A readiness check determines whether a competent engineer can implement the documented work using the document, repository instructions, current codebase, and ordinary engineering judgment **without inventing product requirements or resolving significant unstated architectural decisions**.

This skill does not implement the feature, modify the planning document, or verify an implementation.

## Inputs

The invoking prompt should provide:

* The path of the feature or plan document to review.
* Any additional files, requirements, clarifications, or context that should be considered.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

## Goal

Determine whether the document provides a sufficiently accurate and complete basis for implementation.

Specifically, identify:

* unresolved product decisions;
* unresolved architectural decisions;
* ambiguous requirements;
* unstated assumptions that materially affect the solution;
* contradictions within the document;
* contradictions between the document and current codebase;
* missing information that would force an implementer to guess;
* implementation plans based on an incorrect or outdated understanding of the codebase;
* scope boundaries that are unclear enough to materially change the implementation.

Do not attempt to eliminate every implementation decision.

A competent engineer should retain normal engineering discretion.

## Process

### 1. Read the Planning Document

Understand:

* the problem being solved;
* the desired behavior;
* the stated requirements;
* non-goals and scope boundaries;
* known constraints;
* assumptions;
* open questions;
* the proposed implementation.

Do not evaluate individual statements in isolation. Understand the intended feature as a whole.

### 2. Inspect the Relevant Codebase

Validate claims about the current implementation against the current codebase.

Inspect enough surrounding code to determine whether the proposed implementation is based on an accurate understanding of the system.

Depending on the feature, this may include:

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
* similar existing functionality.

Do not assume that a planning document remains accurate merely because it was accurate when originally written.

Do not perform a general code review. Investigate only as far as necessary to evaluate implementation readiness.

### 3. Check the Problem and Desired Behavior

Determine whether the document clearly establishes:

* what problem is being solved;
* what observable behavior is desired;
* what is within scope;
* any important behavior explicitly outside scope.

Flag ambiguity when multiple reasonable interpretations would produce meaningfully different outcomes.

Do not require unnecessary precision when existing application behavior or established conventions already provide a reasonable answer.

### 4. Check Requirements

Determine whether the requirements are:

* internally consistent;
* consistent with the stated desired behavior;
* sufficiently concrete to guide implementation;
* distinguishable from implementation suggestions and assumptions.

Look for requirements that silently depend on undefined behavior.

Do not invent additional requirements merely because they might be desirable.

### 5. Check Assumptions and Unknowns

Look for assumptions that are presented as facts or requirements.

Ask whether each significant uncertainty can be resolved through:

1. the planning document;
2. repository instructions;
3. the current codebase;
4. established project conventions;
5. ordinary engineering judgment.

If so, it is generally **not** a blocking question.

If different reasonable answers would materially change externally observable behavior, architecture, data representation, compatibility, security characteristics, or scope, the issue may be blocking.

### 6. Check the Proposed Implementation

Determine whether the proposed implementation is technically coherent with the current codebase.

Look for:

* references to files, symbols, APIs, or abstractions that no longer exist or have changed;
* overlooked components that necessarily participate in the behavior;
* incorrect assumptions about control flow or data flow;
* conflicts with established architectural boundaries;
* proposed changes that do not actually satisfy the stated requirements;
* unnecessary changes that indicate the problem may have been misunderstood;
* proposed approaches that appear to require or encourage over-engineering, unnecessary new
  abstraction layers, or obvious duplication relative to the current codebase, when that risk would
  materially affect implementation quality;
* metric-driven churn (e.g., splitting cohesive logic solely to reduce cyclomatic complexity)
  without an independent readability or responsibility justification.

When a maintainability-threatening approach is present and would materially affect implementation
quality, report it. Prefer classifying it as blocking when the plan *mandates* unnecessary layers or
duplication that an implementer cannot responsibly avoid; otherwise note it as a non-blocking
observation that would help the implementer choose a clearer design.

Do not fail readiness solely because a plan lacks a maintainability metrics section or scorecard.
Static maintainability metrics must not be treated as readiness criteria.

Do not reject a plan merely because another implementation could also work.

The question is whether the proposed approach is viable and sufficiently specified, not whether it is the only possible or theoretically optimal design.

### 7. Check Manual Verification Criteria

If the planning document includes manual verification criteria, determine whether they correspond to the desired behavior and important requirements.

Do not execute the verification.

Do not require exhaustive test cases.

Flag missing verification criteria only when the omission makes an important requirement difficult to evaluate manually after implementation.

## Blocking vs. Non-Blocking Issues

Classify findings according to whether they prevent responsible implementation.

### Blocking

An issue is blocking when implementation would require the engineer to make a material decision that should instead be established before implementation.

Examples include:

* ambiguous externally observable behavior;
* contradictory requirements;
* unresolved security or authorization behavior;
* multiple plausible data models with materially different consequences;
* uncertainty about which system owns a responsibility;
* a proposed approach that conflicts with the actual architecture;
* missing information that changes the scope of the feature.

### Non-Blocking

An issue is non-blocking when it can reasonably be resolved during implementation through existing conventions or ordinary engineering judgment.

Examples include:

* local variable names;
* exact private helper decomposition;
* minor refactoring choices;
* placement of small implementation details when project conventions are clear;
* equivalent library or language constructs;
* incidental formatting;
* other decisions that do not materially affect behavior, architecture, compatibility, security, or scope;
* a proposed approach that works but encourages mild duplication or a local special-case that an
  implementer can responsibly replace with a small reusable primitive using ordinary judgment.

Do not manufacture blocking questions from non-blocking implementation details.

Do not treat absence of maintainability metrics, scorecards, or complexity thresholds as a blocking
issue.

## Readiness Standard

A document is **ready** when:

* the problem and desired behavior are sufficiently clear;
* requirements do not contain material contradictions or ambiguities;
* significant assumptions are identified or can be resolved from existing context;
* no unresolved question requires the implementer to invent product behavior;
* no unresolved architectural decision materially changes the solution;
* the proposed implementation is compatible with the current codebase;
* the remaining decisions fall within ordinary engineering judgment.

Readiness does **not** require:

* every implementation detail to be predetermined;
* every edge case to be explicitly documented when existing behavior establishes it;
* elimination of all uncertainty;
* exhaustive test plans;
* certainty that the proposed implementation is the best possible implementation;
* maintainability metrics, scorecards, or static-analysis thresholds.

The standard is implementation readiness, not specification perfection.

## Output

Do not modify any files.

Do not implement the feature.

Do not perform the feature's manual verification.

Return one of the following conclusions.

### Ready

Use when there are no blocking issues.

State clearly that the document is ready for implementation.

Briefly mention any important non-blocking observations only when they would materially help the implementer. Do not create commentary merely to fill the response.

Example:

```text
READY

`docs/FEAT-01_short-summary.md` is ready for implementation.

No unresolved product or architectural decisions require clarification before implementation.
```

### Not Ready

Use when one or more blocking issues remain.

State clearly that the document is not ready and list the blocking issues.

For each blocking issue, explain:

* what is unresolved or contradictory;
* why it matters to implementation;
* what decision or information is needed.

When useful, mention the relevant files, symbols, requirements, or sections that exposed the issue.

Example:

```text
NOT READY

1. Session expiration behavior is ambiguous.

   The document requires sessions to expire after 30 minutes but does not
   establish whether this means 30 minutes after authentication or 30
   minutes of inactivity.

   These behaviors require different implementations and produce
   different user-visible behavior.

   Needed: Decide whether the timeout is absolute or inactivity-based.

2. The proposed implementation assumes `SessionService` owns refresh-token
   rotation, but the current implementation performs rotation in
   `TokenService`.

   Needed: Either update the proposed implementation to use the existing
   ownership boundary or explicitly decide to move that responsibility.
```

Do not propose arbitrary answers to blocking questions merely to make the document ready.

Do not rewrite the planning document as part of the readiness check. The invoking user can provide clarifications and use the appropriate planning skill to incorporate them.

## Review Discipline

Be skeptical without being pedantic.

Actively look for hidden decisions and unsupported assumptions, but do not optimize for finding problems.

A readiness check that always produces questions is not useful.

Prefer resolving uncertainty through inspection of the repository over asking the user questions that the codebase can answer.

Prefer established repository conventions over requiring explicit specification of ordinary implementation details.

Do not confuse disagreement with the proposed implementation with lack of readiness.

Do not expand the scope of the requested feature.

Do not introduce speculative future requirements.

When noting implementation-quality concerns, remember the intended priority for later work:
functionality first, then maintainability/readability, then incidental preferences. Flag plans that
would force over-engineering or obvious duplication when that risk is material; do not demand
metric scorecards.

The central question is:

> Can a competent engineer implement this work correctly without inventing product requirements or making significant unstated architectural decisions?

If yes, the document is ready.
