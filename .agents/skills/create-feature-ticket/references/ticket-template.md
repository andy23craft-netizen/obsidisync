# Feature Ticket Template

Use this template as the default structure for feature tickets.

Not every section is required. Omit sections that do not add useful information rather than filling them with "N/A" or boilerplate.

The final ticket should be thorough enough for implementation without becoming a design document.

---

# Feat-XX - <Concise feature name>

**Status:** Proposed  
**Owner:** <Backend | Frontend | Full Stack | Infrastructure | Service name | etc.>  
**Dependencies:** <Required predecessor tickets, systems, or decisions. Omit if none.>

## Goal

Describe the outcome this feature must achieve and why it exists.

Keep this short. Focus on system or user behavior rather than implementation mechanics.

## Context

Include only the existing architectural or product context necessary to understand the feature.

Useful context may include:

- current behavior
- relevant existing systems
- ownership boundaries
- established architectural decisions
- limitations that motivate the change

Omit this section when the goal and scope are already self-explanatory.

## Scope

Define the behavior and responsibilities included in this ticket.

Prefer concrete requirements and boundaries over implementation steps.

Include important:

- behaviors
- states
- ownership rules
- security constraints
- compatibility requirements
- integration responsibilities

Do not use Scope as a task-by-task implementation checklist.

## Proposed architecture

Include when the feature introduces or materially changes architecture, service boundaries, data ownership, persistence, or data flow.

Describe the proposed implementation shape at the level necessary to prevent architectural ambiguity.

Cover only relevant concerns, such as:

- component or service ownership
- source of truth
- persistence ownership
- data flow
- trust boundaries
- integration boundaries
- migration or compatibility strategy

Clearly distinguish established architecture from new proposals.

Do not prescribe routine internal implementation details.

## Proposed contract

Include when implementation creates or changes a meaningful interface.

Document the proposed contract sufficiently for dependent work to proceed.

This may include:

- endpoints and HTTP methods
- request/response shapes
- events or commands
- interface definitions
- state values and transitions
- error semantics
- authorization behavior
- versioning
- invariants

Prefer concise schemas or examples over long prose when they make the contract clearer.

Mark the contract as proposed when it has not yet been accepted.

## Technical research

Include only when external technical research materially affects the design.

Summarize the question researched and the viable options.

For each serious option, capture the tradeoffs that matter to this project, especially:

- security
- reliability and maintenance
- licensing/cost
- compatibility
- local/self-hosted suitability where relevant
- implementation and operational complexity

State the technically preferred approach when the evidence supports one and briefly explain why.

Link or cite primary sources used for consequential conclusions.

Do not turn this section into a general research report.

## Open questions / decisions required

Include only genuine unresolved decisions.

For each question, state:

**Decision:** <What must be decided?>  
**Why it matters:** <What changes based on this answer?>  
**Options:** <Viable choices, if known.>  
**Recommendation:** <Preferred option and reason, when evidence supports one.>  
**Blocking:** <Yes/No — does implementation require this answer?>

Do not include questions that can be answered by inspecting the repository, reading existing project documentation, or performing reasonable technical research.

If there are no unresolved decisions, omit this section.

## Acceptance criteria

Define observable and testable outcomes.

Acceptance criteria should demonstrate that the purpose of the feature has been achieved.

Include relevant:

- successful behavior
- state transitions
- invariants
- failure behavior
- authentication/authorization behavior
- security boundaries
- compatibility requirements
- regression-sensitive behavior

Avoid criteria that merely describe implementation tasks.

## Testing and validation

Describe testing expectations specific to this feature.

Include only testing categories warranted by the change, such as:

- unit tests
- integration tests
- contract tests
- frontend/component tests
- end-to-end tests
- migration tests
- security/authorization tests
- failure-path tests
- manual validation

Call out specific regressions or boundary conditions that deserve explicit coverage.

## Out of scope

Explicitly identify adjacent work that this ticket does not own when the boundary could otherwise be ambiguous.

Do not list unrelated future ideas simply for completeness.

## Implementation notes

Optional.

Include implementation guidance that is useful but does not belong in the behavioral contract.

Good uses include:

- relevant existing modules or patterns to reuse
- sequencing considerations
- backwards-compatibility cautions
- rollout considerations
- known technical constraints

Do not turn this section into step-by-step pseudocode unless the implementation itself is intentionally prescribed.
