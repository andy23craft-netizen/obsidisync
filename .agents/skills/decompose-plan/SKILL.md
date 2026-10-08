# Decompose Plan

Decompose a large implementation plan into a set of coherent, implementation-ready feature tickets.

The resulting feature tickets collectively represent all remaining work required by the plan. Each ticket should describe a meaningful unit of behavior or capability rather than an arbitrary technical slice.

This skill creates planning artifacts. It does not implement the plan or its feature tickets.

## Inputs

The invoking prompt should provide:

* The path of the plan document to decompose, typically `docs/PLAN-XX_project-name.md`.
* The naming or numbering scheme for the resulting feature documents, if it cannot be inferred.
* Any additional constraints or context relevant to decomposition.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

## Goal

Produce the smallest reasonable set of feature tickets such that:

1. Every requirement and necessary implementation change in the plan belongs to at least one feature ticket.
2. Implementing all resulting feature tickets would fully implement the plan.
3. Each feature ticket represents a coherent unit of work.
4. Ticket boundaries follow behavior and responsibility rather than arbitrary technical layers.
5. Dependencies between tickets are explicit.
6. Tickets can be understood and implemented without repeatedly rediscovering the overall plan.
7. No ticket unnecessarily combines unrelated behavior merely because the changes touch the same files or subsystem.

The decomposition should make implementation easier to reason about, not merely divide a large document into smaller documents.

When choosing among decompositions that all cover the plan, prefer the one that yields more
maintainable tickets: clear ownership, less duplication, fewer brittle special-cases for later
implementers. Priority: satisfy the plan's required functionality; then maximize maintainability of
the resulting tickets and their proposed approaches; then incidental preferences.

## Process

### 1. Understand the Entire Plan

Read the complete plan before choosing ticket boundaries.

Identify:

* the problem or problems being solved;
* desired system behavior;
* user-visible capabilities;
* architectural changes;
* data model changes;
* API changes;
* dependencies;
* constraints;
* non-goals;
* assumptions;
* unresolved questions;
* cross-cutting concerns.

Do not begin creating tickets based only on the first sections of the plan.

Understand how the proposed pieces interact before deciding where boundaries belong.

### 2. Inspect the Current Codebase

Inspect enough of the relevant codebase to understand how the plan maps onto the existing system.

Depending on the plan, this may include:

* architectural boundaries;
* applications and services;
* entry points;
* interfaces and abstractions;
* API contracts;
* persistence;
* shared libraries;
* frontend/backend boundaries;
* configuration;
* generated code;
* tests;
* existing implementations of similar behavior.

Use this investigation to avoid ticket boundaries based on incorrect assumptions about the architecture.

Do not perform implementation.

### 3. Identify Capabilities and Responsibilities

Before creating tickets, identify the meaningful capabilities introduced or changed by the plan.

Prefer thinking in terms such as:

* a user can perform a new operation;
* the system supports a new lifecycle;
* an existing workflow gains new behavior;
* a service gains a coherent responsibility;
* a new integration becomes usable;
* a data concept becomes supported end-to-end.

Avoid beginning with technical categories such as:

* database;
* backend;
* frontend;
* tests;
* models;
* API;
* configuration.

Those technical changes may all belong to a single feature when they collectively implement one coherent behavior.

### 4. Choose Ticket Boundaries

Prefer **vertical slices** that leave the system in a coherent state and implement an independently understandable capability.

When choosing boundaries and foundational work, prefer decompositions that reduce duplicated
abstractions and avoid forcing later tickets into brittle special-cases. Ensure cross-cutting design
responsibilities are owned clearly so implementers are not pushed into tunnel-vision patches.

A good feature ticket should generally have:

* a clear purpose;
* a recognizable behavioral outcome;
* cohesive implementation changes;
* reasonably understandable dependencies;
* a scope that can be implemented without simultaneously implementing unrelated work.

Do not create separate tickets merely because work occurs in different technical layers.

For example, avoid decomposition like:

```text
FEAT-01: Database changes
FEAT-02: Backend changes
FEAT-03: Frontend changes
FEAT-04: Tests
```

when those changes collectively implement one behavior.

Prefer something like:

```text
FEAT-01: Support creating saved searches
FEAT-02: Support editing and deleting saved searches
FEAT-03: Use saved searches when creating reports
```

when those represent meaningful capabilities and sensible implementation boundaries.

### 5. Balance Ticket Size

Do not optimize for either the largest or smallest possible tickets.

Split a ticket when it contains multiple capabilities that:

* can reasonably be implemented independently;
* have different dependencies;
* require substantially different reasoning;
* could be completed without leaving the other capability partially implemented;
* would make the ticket difficult to understand as a single unit.

Keep work together when splitting it would create artificial intermediate states or tightly coupled tickets that provide no meaningful independent capability.

Do not create micro-tickets for:

* individual files;
* individual classes;
* individual database migrations;
* individual endpoints;
* individual UI components;
* adding tests;
* minor refactors;

unless one of those genuinely represents an independent capability or prerequisite.

### 6. Identify Foundational Work

Some plans require foundational work before meaningful vertical features can be implemented.

Examples may include:

* introducing a new core abstraction;
* establishing a new external integration;
* creating shared infrastructure required by several otherwise independent features;
* changing a central data representation.

A foundational ticket is acceptable when the work is genuinely shared and separating it prevents duplication or incoherent feature tickets.

Do not manufacture "infrastructure" tickets merely to preserve traditional technical-layer decomposition.

Do not create foundational abstractions for hypothetical future needs. Prefer a shared primitive when
it prevents duplicated special-cases across later tickets; avoid speculative generality that no
listed ticket requires.

When foundational work has no meaningful standalone user-visible behavior, explain why it deserves an independent ticket and which later tickets depend on it.

### 7. Identify Dependencies

Determine dependencies between feature tickets.

For each dependency, distinguish between:

**Hard dependency**
: A ticket cannot reasonably be implemented until another ticket is complete.

**Ordering preference**
: Implementing another ticket first would be convenient, but is not required.

Do not invent dependencies merely because tickets touch related code.

Prefer decomposition that minimizes hard dependencies when doing so does not damage cohesion.

Avoid circular dependencies. If two proposed tickets require each other to be meaningful or implementable, reconsider whether they should be one ticket.

### 8. Check Plan Coverage

Before writing the final feature documents, account for the entire plan.

Every required behavior or necessary implementation change should be:

* assigned to a feature ticket;
* explicitly identified as already satisfied by the current codebase; or
* explicitly excluded because it is outside the requested decomposition.

Do not silently drop small or cross-cutting requirements.

Pay particular attention to requirements that span several capabilities, such as:

* authorization;
* error behavior;
* compatibility;
* configuration;
* shared domain rules;
* observability;
* data consistency.

Assign each such concern to the ticket or tickets where it must actually be implemented.

Do not create a miscellaneous catch-all ticket merely to hold requirements that were not thoughtfully assigned.

### 9. Check for Overlap

Feature tickets should not independently claim ownership of the same implementation work.

Some overlap in context is acceptable and often necessary.

Duplication of responsibility is not.

If multiple tickets depend on the same behavior, determine whether:

* one ticket should establish the behavior and others depend on it;
* the behavior belongs in a foundational ticket;
* the proposed tickets should be merged;
* the shared concern naturally belongs in each ticket's own implementation.

The implementer should be able to tell which ticket is responsible for making each substantive change.

### 10. Create the Feature Documents

Create each feature ticket using the repository's feature-planning conventions and the principles of the `plan-feature` workflow.

Each ticket should stand on its own sufficiently for implementation while retaining relevant context from the larger plan.

When proposing implementations inside tickets, favor maintainable designs when multiple options
satisfy the requirements: clear ownership, reuse of existing patterns, and reusable primitives over
brittle local special-cases. Do not recommend metric-only refactors (e.g., splitting a function
solely to reduce cyclomatic complexity) unless independently justified by readability or
responsibility boundaries. Static maintainability metrics must not be treated as goals to optimize
in tickets.

Do not require the implementer to repeatedly consult the PLAN document merely to understand the ticket's requirements.

At the same time, do not duplicate the entire PLAN document into every ticket.

Include the context necessary to understand:

* why the ticket exists;
* what behavior it owns;
* relevant constraints;
* dependencies on other tickets;
* its implementation scope.

## Feature Ticket Structure

Use the established feature-document structure.

Where dependencies exist, add a `Dependencies` section.

For example:

```markdown
# FEAT-03: Use Saved Searches When Creating Reports

## Problem

...

## Desired Behavior

...

## Requirements

...

## Dependencies

- **FEAT-01: Support Creating Saved Searches** — Hard dependency. Reports require persisted saved-search definitions.

## Proposed Implementation

...

## Manual Verification

...
```

Do not add a `Dependencies` section when the ticket has no meaningful dependencies.

## Decomposition Quality Checks

Before completing the decomposition, evaluate the proposed ticket set against the following questions.

### Completeness

If every feature ticket were implemented, would the entire plan be implemented?

If not, the decomposition is incomplete.

### Cohesion

Does each ticket describe one coherent capability or responsibility?

If its contents are connected only because they appear near each other in the PLAN document, reconsider the boundary.

### Independence

Can tickets that do not have genuine dependencies be implemented independently?

If unrelated tickets require coordinated implementation, reconsider the boundaries.

### Verticality

Do tickets generally represent behavior across whatever technical layers are necessary to implement that behavior?

If the decomposition primarily resembles database/backend/frontend/test buckets, reconsider it.

### Ownership

For every substantive requirement, is it clear which ticket owns its implementation?

If not, resolve the ambiguity.

Would the chosen ownership push implementers into tunnel-vision patches or duplicated special-cases
when a shared primitive or clearer responsibility boundary would serve several tickets?

### Duplication

Would two tickets independently implement the same substantive behavior?

If so, resolve the overlap.

### Size

Is any ticket so large that it contains multiple independently meaningful capabilities?

Is any ticket so small that it represents an implementation detail rather than a meaningful unit of work?

Adjust boundaries when appropriate.

### Intermediate Coherence

After each ticket is implemented, does the repository remain in a coherent state?

Avoid decomposition that requires committing half of a feature merely because the other half was assigned to another technical-layer ticket.

## Handling Open Questions

Do not hide unresolved decisions by distributing them among feature tickets.

If an unresolved question affects only one ticket, include it in that ticket.

If an unresolved question affects the decomposition itself or materially changes several ticket boundaries, do not guess.

Report the blocking question instead of creating a decomposition that depends on an arbitrary answer.

If the uncertainty can reasonably be resolved from the codebase, repository conventions, or straightforward investigation, investigate it rather than escalating it.

## Plan Document

Do not rewrite the PLAN document merely to reflect the decomposition unless explicitly requested.

Do not remove requirements from the PLAN document because they have been assigned to feature tickets.

The PLAN remains the definition of the larger initiative. The feature tickets describe the implementable units that collectively realize it.

The decomposition should satisfy this invariant:

> Implementing all generated feature tickets satisfies the remaining implementation requirements of the PLAN.

## Output

Create the necessary feature documents at the paths implied by the invoking prompt and repository conventions.

Do not implement any feature.

Do not perform post-implementation verification.

After creating the documents, report:

* which feature documents were created;
* a one-sentence description of each ticket's responsibility;
* any hard dependencies between tickets;
* any blocking questions that prevented complete decomposition.

Do not produce a lengthy restatement of the feature documents.

## Review Discipline

Optimize for **coherent implementation boundaries**, not ticket count.

Do not split work merely because it touches different technologies.

Do not combine work merely because it touches the same technology.

Do not turn testing, migrations, refactoring, documentation, or configuration into standalone tickets unless they genuinely represent independent work required by the plan.

Do not create speculative tickets for possible future needs.

Do not add requirements that are absent from the PLAN and unsupported by the current codebase.

Do not preserve the PLAN's section boundaries when better implementation boundaries exist.

Use dependencies deliberately rather than forcing every ticket into a linear sequence.

The central questions are:

> Does each ticket represent a coherent unit of behavior or responsibility?

and:

> If all of these tickets are implemented, will the PLAN be implemented completely without duplicated or orphaned work?
