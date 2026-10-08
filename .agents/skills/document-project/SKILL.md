# Document Project

Create or refresh supplementary project documentation based on the current codebase.

Use Diátaxis to separate documentation according to the reader's need rather than according to arbitrary repository structure.

Documentation should solve a real information need. Do not create pages merely because a documentation framework provides a category for them.

## Documentation Model

Classify documentation according to Diátaxis:

| Mode        | Reader need          | Character                          |
| ----------- | -------------------- | ---------------------------------- |
| Tutorial    | Learning             | Guided experience                  |
| How-to      | Accomplishing a goal | Practical steps                    |
| Reference   | Looking something up | Precise facts                      |
| Explanation | Understanding        | Concepts, rationale, relationships |

The root `README.md` serves as the project's overview and front door.

Not every project requires substantial material in every quadrant.

## Phase 1 — Survey

Inspect the repository before deciding what to document.

Read:

* `README.md`;
* `AGENTS.md`;
* existing `docs/`;
* relevant source code;
* tests;
* examples;
* configuration;
* CLI definitions;
* public APIs;
* architecture diagrams;
* comments and docstrings;
* ADRs or design documents;
* the `Makefile`.

Identify:

* primary audiences;
* common user/developer goals;
* concepts requiring explanation;
* stable surfaces requiring reference;
* existing documentation gaps;
* documentation that is stale;
* documentation whose current location or style does not match its purpose.

Do not assume that a missing Diátaxis quadrant is a documentation gap.

## Phase 2 — Identify the Need

Every new document must answer:

> What will a reader be able to do or understand after reading this that they cannot easily do or understand now?

If that question has no concrete answer, do not create the document.

Before writing, classify the need.

### Tutorial

Use a tutorial when the reader is learning through a controlled, successful experience.

Tutorials should:

* guide the reader from beginning to end;
* minimize unnecessary choices;
* produce visible progress;
* teach through doing;
* avoid lengthy conceptual digressions.

Link to explanation and reference instead of embedding them.

### How-to Guide

Use a how-to guide when the reader already has context and wants to accomplish a specific goal.

Organize how-to documentation around the user's goal, not around software components.

Prefer goal-oriented titles such as:

* "Configure local authentication"
* "Add a new data source"
* "Deploy the service locally"

over implementation-oriented titles such as:

* "Authentication module"
* "Data source classes"
* "Docker"

When the project uses literate-programming-style documentation, prefer how-to material near the relevant implementation rather than duplicating it under `docs/`.

Create a standalone how-to page only when it improves discoverability or spans implementation boundaries.

### Reference

Use reference documentation for authoritative facts.

Examples include:

* command glossaries;
* configuration options;
* environment variables;
* API surfaces;
* schemas;
* indices;
* supported values;
* file formats.

Reference documentation should optimize for lookup.

Prefer:

* tables;
* concise definitions;
* stable headings;
* predictable organization;
* links to authoritative generated documentation where appropriate.

Do not mix tutorials or architectural essays into reference pages.

### Explanation

Use explanation documentation to help readers understand:

* architecture;
* design decisions;
* tradeoffs;
* domain concepts;
* system relationships;
* why the implementation is shaped as it is.

Architecture documentation normally belongs here.

Use C4 diagrams where structural relationships matter.

Use Mermaid where sequences, flows, or state transitions are clearer visually.

## Phase 3 — Plan Placement

Before creating a file, determine where it belongs in the existing documentation system.

Prefer the project's established conventions.

A possible structure is:

```text
docs/
├── architecture/
├── tutorials/
├── explanation/
└── reference/
```

This is not a required scaffold.

Do not create empty directories.

Do not move documentation solely to achieve visual symmetry.

If an existing document mixes modes, improve it when doing so materially helps readers. Do not reorganize unrelated documentation merely because it could theoretically be classified more cleanly.

## Phase 4 — Write

Human-facing documentation should follow these general conventions.

### Start broad

Use the Wikipedia pattern:

1. title;
2. one-sentence definition;
3. short summary;
4. progressively more specific sections;
5. citations/references where appropriate.

A reader should understand the subject before encountering details.

### Answer the fundamental questions

Where applicable, establish:

* What is this?
* What can someone accomplish with it?
* Who is it for?
* Why does it exist?
* Where does it fit into the larger system?

Do not force all five questions into every document.

### Keep readers oriented

Use public-speaking techniques in prose.

**Roadmap:** tell readers what the document will cover when the structure is not obvious.

**Signpost:** use headings and transitions to show where the reader is.

A reader scrolling through the page should regularly encounter meaningful headings.

As a guideline:

* keep sections around one screenful where practical;
* approximately 50 lines or fewer per section;
* approximately 120 characters maximum line length.

Do not distort good prose merely to satisfy these approximate limits.

### Use deliberate redundancy

Do not optimize documentation for saying every fact exactly once.

For important or ambiguous concepts, two or three examples from different perspectives may communicate the underlying idea more precisely than a single abstract statement.

Avoid pointless repetition, but permit useful reinforcement.

### Use visuals

For substantial human-facing pages, consider an amusing or memorable image near the top when appropriate.

Possible sources include XKCD and Wikimedia Commons.

Only use externally sourced media when its license permits the intended use and required attribution can be preserved.

Technical visuals should earn their place.

Use:

* C4 for architecture;
* Mermaid for flows, sequences, and states;
* tables for structured comparison/reference;
* code examples for executable concepts.

Do not use a diagram where two sentences are clearer.

## Phase 5 — Link

Documentation should be navigable.

When adding a page:

* link to it from the nearest appropriate overview or index;
* add a README link when the page represents major project documentation;
* link to authoritative reference rather than copying large reference sections;
* link to explanation from tutorials/how-tos when readers may need conceptual background;
* link to goal-oriented instructions from reference when readers may need to perform an operation.

Avoid orphaned documents.

## Phase 6 — Diagrams

When documentation requires a new or changed PlantUML/C4 diagram:

* update the diagram source;
* use the repository's `make diagrams` workflow;
* embed the generated output in the relevant Markdown page.

Do not hand-edit generated diagram files.

For Mermaid, embed the source directly in Markdown when supported by the repository's documentation renderer.

Do not introduce diagrams merely to decorate documentation.

## Phase 7 — Refresh Existing Material

When updating existing documentation, reconcile it with the current repository.

Remove:

* stale instructions;
* commands that no longer exist;
* obsolete architectural descriptions;
* duplicated sections that no longer serve a purpose;
* references to removed features.

Preserve useful historical rationale only when it helps explain the current system.

Documentation should primarily describe the current state.

Do not turn ordinary documentation into a changelog.

## Phase 8 — Validate

Before finishing:

1. Check factual claims against repository evidence.
2. Check commands against the actual build/development interface.
3. Check internal links where practical.
4. Run relevant documentation generation.
5. Run `make diagrams` when PlantUML/C4 sources changed.
6. Check that generated diagrams are embedded correctly.
7. Check that new pages are discoverable from an appropriate parent page.
8. Re-read each document according to its intended Diátaxis mode.
9. Remove empty or speculative sections.
10. Review the final diff for unrelated documentation churn.

Do not equate successful rendering with human verification.

The user remains responsible for confirming that the documentation accurately communicates the intended product, workflow, and architecture.

## Guards

* Do not invent functionality.
* Do not document speculative architecture as current architecture.
* Do not create documentation solely to populate a Diátaxis quadrant.
* Do not create empty scaffolding.
* Do not mix explanation into reference when a link is clearer.
* Do not turn tutorials into exhaustive reference manuals.
* Do not organize how-to guides around internal module structure instead of user goals.
* Do not duplicate large bodies of authoritative information.
* Do not rewrite unrelated documentation merely to make its classification purer.
* Do not treat successful builds or renders as proof that documentation is correct.
* Do not perform unrelated application changes while documenting the project.
