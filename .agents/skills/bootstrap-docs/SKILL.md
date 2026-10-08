# Bootstrap Project Documentation

Establish the baseline documentation and documentation tooling for a new project after its initial code skeleton exists.

This skill documents the project that actually exists. It does not invent planned architecture, commands, workflows, or capabilities merely to make the documentation look complete.

## Goals

A completed bootstrap should leave the repository with:

* a useful `README.md` for humans;
* a useful `AGENTS.md` for coding agents;
* an appropriate `docs/` structure;
* a `Makefile`, or compatible additions to the existing `Makefile`;
* a canonical `make diagrams` command when generated diagrams are present;
* an initial architecture description when the repository contains enough evidence to support one;
* documentation that points readers toward deeper material instead of duplicating it everywhere.

Do not create documentation merely to fill a template.

## Phase 1 — Survey the Repository

Before writing anything, inspect the repository.

Read, as applicable:

* existing `README.md`;
* existing `AGENTS.md`;
* `Makefile`;
* package/project manifests;
* application entry points;
* deployment configuration;
* container configuration;
* CI configuration;
* configuration examples;
* public APIs;
* CLI entry points;
* tests;
* existing `docs/`;
* existing PlantUML and Mermaid diagrams;
* comments and docstrings that describe architectural constraints.

Determine:

1. In one sentence, what is this project?
2. What can a user accomplish with it?
3. Who are its primary users?
4. What are the principal developer workflows?
5. What are the major architectural components?
6. What commands are actually supported?
7. What knowledge would a coding agent need before safely modifying the repository?

Prefer evidence from the repository over inference.

If an important fact cannot be determined, either omit it or mark it clearly as unresolved. Do not fabricate an answer.

## Phase 2 — Establish Documentation Structure

Use Diátaxis as the conceptual model for human-facing documentation.

The four modes are:

* **Overview / orientation** — primarily the root `README.md`.
* **Tutorials** — learning-oriented material that walks a reader through a controlled experience.
* **How-to guides** — goal-oriented instructions. Prefer these close to the implementation when the project uses literate-programming-style documentation.
* **Reference** — precise descriptions of commands, configuration, APIs, schemas, indices, and glossaries.
* **Explanation** — conceptual and architectural material explaining why the system is shaped as it is.

Diátaxis formally distinguishes tutorials, how-to guides, reference, and explanation. Treat the root README as the project's front-door overview rather than as a fifth Diátaxis quadrant.

Do not create directories or placeholder documents for categories that have no useful content.

A typical repository may resemble:

```text
.
├── AGENTS.md
├── README.md
├── Makefile
└── docs/
    ├── architecture/
    │   ├── README.md
    │   └── diagrams/
    │       ├── context.puml
    │       └── container.puml
    ├── tutorials/
    └── reference/
```

This is an example, not a required scaffold.

Adapt the structure to the repository.

## Phase 3 — Write README.md

`README.md` is the project's front door for humans.

Start with a one-sentence definition of the project.

Follow it with a short summary answering:

* What does this project do?
* Who is it for?
* What can someone accomplish with it?

Then introduce progressively more detail.

Prefer a structure such as:

```markdown
# Project Name

One-sentence definition.

Two or three paragraphs establishing purpose, audience, and major capabilities.

## Getting Started

...

## How It Works

...

## Development

...

## Documentation

...

## License

...
```

Only include sections justified by the project.

### README writing rules

Write like a good encyclopedia article:

* definition first;
* summary before detail;
* broad concepts before specialized ones;
* links to deeper material rather than enormous digressions.

Use roadmapping and signposting.

At transitions, make it clear:

* where the reader is;
* what they have learned;
* where the document is going next.

Keep sections short enough that readers regularly encounter headings.

As a guideline:

* approximately one screenful per section;
* roughly 50 lines or fewer where practical;
* approximately 120 characters maximum line length.

These are readability guidelines, not mechanical limits.

Some deliberate repetition is useful.

When an important concept is difficult or ambiguous, explaining it through two or three examples from different angles is preferable to forcing every fact to appear exactly once.

### Human-facing images

For substantial human-facing overview or explanation pages, consider a humorous, memorable, or illustrative image near the beginning.

Good sources include:

* XKCD;
* Wikimedia Commons;
* other assets whose licenses permit repository use.

Do not add an image merely to satisfy this convention.

When using an external image:

* verify its license;
* preserve required attribution;
* prefer stable sources;
* avoid hotlinking when repository conventions favor local assets.

Never add decorative imagery to `AGENTS.md`.

## Phase 4 — Write AGENTS.md

`AGENTS.md` is operational documentation for coding agents working in the repository.

It is not a second README.

Write it for an agent that has access to the repository but lacks project-specific context.

Start with a concise statement of the project's purpose, then document the rules needed to modify it safely.

Cover applicable topics such as:

* repository structure;
* architectural boundaries;
* important entry points;
* build commands;
* test commands;
* lint/format commands;
* development commands;
* code-generation commands;
* diagram-generation commands;
* naming and style conventions;
* configuration conventions;
* testing expectations;
* files or directories that should not be edited manually;
* generated artifacts;
* relevant documentation;
* known architectural constraints.

Prefer executable commands over prose descriptions.

For example:

```markdown
## Commands

| Task | Command |
| --- | --- |
| Build | `make build` |
| Test | `make test` |
| Lint | `make lint` |
| Generate diagrams | `make diagrams` |
```

Only document commands that actually exist.

### Agent guidance

Tell agents how to discover information rather than attempting to encode the entire repository into `AGENTS.md`.

Prefer:

> API schemas live under `src/contracts/`; treat them as the source of truth for external request and response shapes.

over:

> The `FooRequest` object has properties X, Y, and Z...

when those details are already maintained authoritatively elsewhere.

Avoid rules that merely restate obvious language or framework conventions.

Document project-specific knowledge.

## Phase 5 — Establish Makefile Conventions

Projects should expose common developer operations through `make`.

Preserve an existing `Makefile` and its conventions.

Do not replace working project commands merely to standardize their spelling.

Where appropriate, provide targets such as:

```make
.PHONY: help build test lint format diagrams

help:
	@...

build:
	...

test:
	...

lint:
	...

format:
	...

diagrams:
	...
```

Only add targets whose underlying operations are known.

Do not create fake targets containing placeholder commands.

## Phase 6 — Establish Diagram Workflow

Architecture diagrams should be reproducible.

Prefer:

* C4 for architectural structure;
* PlantUML/C4-PlantUML for C4 source;
* Mermaid for smaller diagrams that render naturally inside Markdown.

Store diagram source in the repository.

Generated C4 artifacts must be reproducible with:

```bash
make diagrams
```

Do not require contributors to remember the underlying PlantUML invocation.

A typical arrangement is:

```text
docs/
└── architecture/
    ├── README.md
    └── diagrams/
        ├── context.puml
        ├── context.svg
        ├── container.puml
        └── container.svg
```

Prefer SVG for generated documentation diagrams unless project constraints require another format.

Markdown should embed the generated artifact rather than requiring a reader to interpret PlantUML source.

For example:

```markdown
![System context](diagrams/context.svg)
```

Do not create diagram levels unsupported by the architecture.

A simple application may need only a System Context diagram. A distributed system may justify Context and Container diagrams.

Do not manufacture complexity to fill the C4 hierarchy.

## Phase 7 — Cross-Link Documentation

Documentation should form a navigable system.

At minimum:

* `README.md` should link to deeper documentation that exists;
* `AGENTS.md` should point agents to authoritative architecture and reference material;
* architecture pages should link to relevant reference material where useful;
* supplementary documentation should link back toward appropriate overview material.

Avoid circular prose duplication.

Repeat short orienting explanations where useful, then link to the authoritative detail.

## Phase 8 — Validate

Before finishing:

1. Check every documented command against the repository.
2. Run applicable lightweight documentation/build commands.
3. Run `make diagrams` if the target was created or changed.
4. Confirm generated diagram files exist.
5. Confirm Markdown diagram paths resolve.
6. Check internal documentation links where practical.
7. Check that `README.md` describes the current project rather than an aspirational future project.
8. Check that `AGENTS.md` contains project-specific operational guidance rather than generic programming advice.
9. Check that no empty Diátaxis scaffolding was created.
10. Review the diff for accidental replacement of useful existing documentation.

Do not claim that documentation is correct merely because generation commands succeeded.

The user remains responsible for validating that the documentation accurately communicates the intended product and architecture.

## Guards

* Do not invent project capabilities.
* Do not invent commands.
* Do not invent architectural components.
* Do not overwrite useful existing documentation without incorporating it.
* Do not create empty documentation scaffolds.
* Do not turn `README.md` into exhaustive reference documentation.
* Do not turn `AGENTS.md` into a duplicate README.
* Do not put human-oriented decorative images in `AGENTS.md`.
* Do not hand-maintain generated diagram artifacts when they can be generated from source.
* Do not add PlantUML diagrams without a reproducible generation command.
* Do not force every Diátaxis quadrant to exist.
* Do not perform unrelated application refactoring while bootstrapping documentation.
