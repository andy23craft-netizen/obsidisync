---
name: create-feature-ticket
description: Investigate, research, design, and write implementation-ready feature tickets for this project.
---

# Create Feature Ticket

Create a concise but implementation-ready feature ticket from a feature request, idea, bug-derived requirement, or architectural need.

The ticket is intended to be handed to an implementation agent. Do enough investigation and technical planning that the implementation agent should not discover avoidable product, contract, architecture, or dependency blockers after beginning work.

Do not begin by writing the ticket. Investigate first.

## Core principles

- Be thorough without being verbose.
- Describe desired behavior and important constraints more precisely than routine implementation details.
- Preserve established project architecture and conventions unless there is a concrete reason to change them.
- Do not invent requirements merely to make the ticket appear complete.
- Do not manufacture open questions merely to populate a section.
- Resolve questions yourself when the repository, project documentation, existing contracts, or technical research provides a defensible answer.
- Escalate genuine product decisions, ambiguous requirements, destructive or difficult-to-reverse choices, security-sensitive decisions, and architectural choices with materially different tradeoffs.
- Distinguish established decisions from proposed decisions.
- Prefer incremental changes over unnecessary redesign.
- Explicitly identify assumptions when they materially affect implementation.

## Phase 1 — Understand the request

Determine:

- What outcome is actually being requested?
- Who or what consumes the feature?
- Which existing system owns the relevant behavior or data?
- What is explicitly in scope?
- What appears adjacent but should remain out of scope?
- Are there existing decisions or tickets that constrain the feature?

Do not assume the user's initial description contains the complete technical problem.

## Phase 2 — Inspect the project

Before designing the ticket, inspect the relevant repository areas and project documentation.

Look for:

- existing architecture and ownership boundaries
- related features
- APIs and contracts
- schemas and models
- persistence patterns and migrations
- authentication and authorization
- configuration
- frontend/backend boundaries
- service boundaries
- tests and fixtures
- naming conventions
- existing documentation and decision records
- dependencies on unfinished work

Search narrowly first, then expand when necessary.

Do not perform a broad repository survey when a small number of relevant files can establish the required context.

When the proposed feature conflicts with an established project decision, call out the conflict rather than silently designing around it.

## Phase 3 — Identify decisions and blockers

Determine which questions fall into each category:

### Already answered

The repository, project documentation, existing contract, or established architecture provides the answer.

Use that answer.

### Technically resolvable

The question can reasonably be answered through technical analysis or research.

Resolve it rather than asking the user.

### Genuine decision required

The choice depends on product intent, UX preference, acceptable risk, irreversible architecture, security posture, cost, or materially different tradeoffs.

Present the decision clearly before implementation begins.

Do not defer routine engineering decisions to the user.

For each consequential architectural decision, explain both the technical choice and its practical purpose.

Prefer small subsections when the feature has multiple concerns, such as:

- Service ownership
- Data and persistence
- Network exposure
- Authentication and secrets
- Lifecycle and recovery
- Integration boundaries

Do not compress unrelated architectural decisions into a single dense bullet.

## Phase 4 — Perform technical research when warranted

Research is warranted when implementation depends materially on choosing or validating an external:

- library or framework
- protocol or standard
- engine
- integration
- API
- storage mechanism
- authentication/security approach
- deployment mechanism
- file format
- browser/platform capability
- infrastructure component

Prefer authoritative primary sources such as official documentation, specifications, upstream repositories, and maintained project documentation.

Evaluate viable options using these priorities:

1. Security
2. Reliability and active maintenance
3. Free/open-source availability where practical
4. Compatibility with the existing project stack
5. Local-first or self-hosted operation where relevant
6. Simplicity and operational burden

Free is a preference, not a reason to accept a materially weaker security or reliability posture.

For meaningful alternatives, summarize:

- what the option is
- relevant advantages
- relevant disadvantages
- maintenance/project health
- licensing or cost implications
- security implications
- compatibility with the current architecture
- implementation/operational complexity

Recommend an approach when the evidence supports one.

If the correct choice depends on product priorities rather than technical superiority, present the options and identify the specific decision required.

Do not turn minor implementation choices into research projects.

## Phase 5 — Design the proposed solution

Before writing acceptance criteria, establish the implementation shape sufficiently to expose missing decisions.

Consider, where applicable:

- component/service ownership
- data ownership
- persistence
- data flow
- API boundaries
- schemas
- state transitions
- authentication and authorization
- trust boundaries
- failure behavior
- compatibility
- migration
- observability
- external dependencies

Do not over-specify routine implementation mechanics.

The ticket should constrain behavior, interfaces, ownership, security boundaries, and important architectural decisions while leaving ordinary implementation choices to the implementing agent.

## Contracts

When a feature introduces or changes a contract, propose it explicitly.

Contracts may include:

- HTTP endpoints
- request/response schemas
- events
- commands
- interfaces
- database-visible invariants
- error semantics
- state machines
- frontend/backend boundaries
- service-to-service communication
- versioning behavior

Use concrete examples when they materially reduce ambiguity.

Mark proposed contracts as proposed unless they are already established.

Do not invent a detailed contract when the feature does not require one.

## Open questions

Include an Open Questions / Decisions Required section only when unresolved decisions remain.

For every open question:

- explain why it matters
- identify the viable choices when known
- provide a technical recommendation when evidence supports one
- identify who must decide when appropriate
- state whether implementation is blocked by the answer

A ticket with no genuine open questions should say so briefly or omit the section according to the project ticket convention.

## Acceptance criteria

Acceptance criteria must describe observable, testable outcomes.

They should cover:

- primary successful behavior
- important state transitions
- meaningful failure behavior
- relevant security or authorization boundaries
- compatibility/invariants
- requirements whose regression would violate the purpose of the feature

Acceptance criteria should be sufficiently granular that an implementation agent can use them as a completion checklist and a reviewer can determine whether the feature is actually finished.

Prefer one independently verifiable behavior per criterion.

Do not combine several significant behaviors into one criterion merely to keep the ticket short.

Avoid criteria that merely restate implementation tasks.

## Testing and validation

Identify testing requirements appropriate to the change.

Consider:

- unit tests
- integration tests
- contract tests
- frontend tests
- end-to-end tests
- migration tests
- authorization/security tests
- failure-path tests
- backwards compatibility
- manual validation when automation is impractical

Do not demand every category for every ticket.

## Ticket output

Use the structure in:

`references/ticket-template.md`

Sections may be omitted when genuinely irrelevant.

## Ticket depth and readability

The ticket must be implementation-ready, not merely a concise summary of the intended change.

Prefer enough detail that an implementation agent can proceed without rediscovering consequential requirements, architecture, contracts, security boundaries, persistence behavior, or failure semantics.

Do not optimize for the shortest possible ticket.

At the same time, avoid unnecessary repetition, speculative implementation detail, and long explanations of routine engineering work.

### Write for two audiences

The ticket must serve both:

1. the implementation agent or engineer who needs precise technical requirements; and
2. the project owner who must be able to understand and approve consequential technical decisions.

When introducing a consequential technical decision, briefly explain:

- what is being done;
- why this approach is being used;
- what important behavior or risk it addresses; and
- when relevant, what meaningful alternative was rejected.

Do not assume the project owner understands infrastructure, networking, security, database, protocol, or framework terminology.

Use technical terminology where precision requires it, but explain its practical meaning the first time it materially affects the design.

For example, do not merely state that a service binds to `127.0.0.1`.
Explain that binding to `127.0.0.1` prevents other machines from connecting directly to that service and forces access through the intended reverse proxy.

### Appropriate level of detail

Expand consequential decisions involving:

- security and trust boundaries
- authentication and authorization
- public network exposure
- persistent data and data loss
- backup and recovery
- migrations
- service ownership
- cross-service contracts
- external dependencies
- irreversible or difficult-to-change architecture
- failure and degraded behavior

Routine implementation mechanics may remain concise.

A longer ticket is acceptable when the feature genuinely has more architectural or operational complexity.

## Stop condition

Do not present a ticket as implementation-ready when unresolved questions genuinely block safe implementation.

Instead, produce the ticket with those blockers clearly identified and present the decisions or researched options needed to resolve them.

Never hide uncertainty behind an arbitrary implementation choice.

