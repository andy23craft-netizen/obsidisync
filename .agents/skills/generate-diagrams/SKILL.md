# Generate Project Diagrams

Create or update architecture diagrams from the current repository and render generated diagram artifacts through the project's canonical Makefile workflow.

Diagrams are documentation of the architecture that exists, not proposals for architecture that has not been implemented.

## Scope

Use this skill to:

* create C4 diagram source;
* update C4 diagrams after architectural changes;
* add appropriate Mermaid diagrams to Markdown;
* establish or repair `make diagrams`;
* regenerate committed diagram artifacts;
* update documentation that embeds changed diagrams.

Do not use this skill to redesign the application's architecture.

## Phase 1 — Inspect

Before changing diagrams, inspect:

* `README.md`;
* `AGENTS.md`;
* `Makefile`;
* existing `docs/`;
* existing `.puml`, `.plantuml`, `.mmd`, and generated diagram files;
* deployment configuration;
* service entry points;
* container definitions;
* infrastructure definitions;
* external API clients;
* persistence boundaries;
* relevant architecture documentation.

Identify architecture from repository evidence.

For C4 specifically, determine:

* people/actors;
* the software system;
* external systems;
* deployable/runnable containers;
* important relationships.

Do not infer a component merely because it would be conventional.

## Choose the Diagram Type

Use the simplest diagram that communicates the needed information.

### C4 / PlantUML

Prefer C4 diagrams for software architecture.

Use:

* **System Context** to show users, the system, and external systems;
* **Container** to show major deployable/runtime units;
* lower C4 levels only when they provide meaningful information that is not clearer in code or prose.

Do not create every C4 level automatically.

### Mermaid

Prefer Mermaid when the diagram belongs directly in a Markdown explanation and is naturally expressed as:

* a sequence;
* a state transition;
* a flowchart;
* a dependency relationship;
* a small data flow;
* another concise behavioral relationship.

Do not convert a useful C4 architecture diagram to Mermaid merely for uniformity.

## Write Diagram Source

PlantUML source belongs in the repository.

Use clear, stable identifiers.

Prefer descriptions that communicate responsibilities rather than implementation trivia.

Relationships should explain why two elements communicate when that information is useful.

Avoid diagrams dominated by framework internals.

A reader should be able to understand the architecture without first reading the source code.

## Keep Diagrams Readable

A diagram is not an inventory.

If a diagram becomes crowded:

* move detail into a lower-level diagram;
* omit irrelevant internal detail;
* group related concepts where the notation supports it;
* explain secondary details in prose.

Prefer several purposeful diagrams over one enormous diagram.

## Makefile Workflow

PlantUML diagrams must be generated through:

```bash
make diagrams
```

If the repository already provides that target, use it.

If diagram generation exists under another command, integrate it into `make diagrams` rather than creating a competing workflow.

If no target exists, add one using the project's existing tooling where possible.

Do not introduce a new diagram-generation dependency when the repository already has a suitable one.

The target should be deterministic and safe to rerun.

## Generated Artifacts

Prefer SVG for generated C4 diagrams unless repository constraints require another format.

Keep source and generated output organized predictably.

For example:

```text
docs/architecture/diagrams/
├── context.puml
├── context.svg
├── container.puml
└── container.svg
```

Follow an existing repository convention when one exists.

Do not manually edit generated SVG/PNG output.

Edit the source and regenerate it.

## Embed Diagrams

Generated diagrams should appear in the documentation where they are useful.

For example:

```markdown
## System context

The application sits between the end user and the external identity and data services shown below.

![System context](diagrams/context.svg)
```

A diagram should have enough surrounding prose that the reader understands:

* what they are looking at;
* why the diagram matters;
* what detail to notice.

Do not drop unexplained diagrams into documentation.

Use roadmapping and signposting to connect diagrams to the surrounding explanation.

## Validate

After changing diagram source:

1. Run:

   ```bash
   make diagrams
   ```

2. Confirm the command succeeds.

3. Confirm expected output files were produced.

4. Confirm Markdown references point to the generated files.

5. Check for obsolete generated artifacts.

6. Review diagrams for accidental architecture claims unsupported by the repository.

7. Review the diff to ensure generated output corresponds to the changed sources.

Where practical, also run the repository's documentation build or link checker.

## Guards

* Architecture diagrams describe current architecture unless explicitly labeled as proposed.
* Never invent services, dependencies, actors, or communication paths.
* Do not create every C4 level by default.
* Do not put implementation trivia into high-level C4 diagrams.
* Do not manually edit generated diagram artifacts.
* Do not bypass `make diagrams` for the canonical workflow.
* Do not silently replace an existing diagram toolchain.
* Do not refactor application architecture merely to make a diagram cleaner.
* Do not claim architectural correctness solely because PlantUML rendered successfully.
