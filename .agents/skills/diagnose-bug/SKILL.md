# Diagnose Bug

Investigate a reported bug and create or update a bug ticket describing the current understanding, evidence, active hypotheses, necessary diagnostics, established root cause when known, and proposed remediation when justified.

Bug tickets describe **current diagnostic state and remaining work**. They are not chronological debugging logs or records of every hypothesis previously considered.

This skill may investigate the codebase and reason about supplied diagnostic evidence. It does not implement fixes or perform final bug verification.

## Inputs

The invoking prompt should provide:

* The path of the bug document to create or update, typically `docs/BUG-XX_short-summary.md`.
* A description of the observed problem.
* Any available error messages, logs, stack traces, reproduction information, diagnostic output, or other evidence.
* Any additional files, constraints, or context that should be considered.

Also consider repository instructions such as `AGENTS.md` and any applicable scoped rules.

When updating an existing bug ticket, treat newly supplied diagnostic information as evidence to reconcile with the current ticket.

## Goal

Produce a bug document that allows a competent engineer to understand:

1. What behavior has actually been observed.
2. What behavior was expected.
3. What evidence is currently available.
4. What conclusions are established by that evidence.
5. What explanations remain hypotheses.
6. What diagnostic steps would most effectively reduce the remaining uncertainty.
7. What root cause has been established, if any.
8. What remediation is appropriate, if the evidence supports one.
9. What observable behavior the human should verify after remediation.

The document should clearly distinguish **what is known from what is suspected**.

## Core Principle

Do not allow plausibility to become fact.

A technically convincing explanation is still a hypothesis until supported by evidence.

Maintain a clear distinction between:

**Observation**
: Something directly reported, reproduced, logged, measured, or visible in supplied diagnostic output.

**Inference**
: A conclusion logically supported by observations but not itself directly observed.

**Hypothesis**
: A plausible explanation that has not yet been established.

**Established Root Cause**
: An explanation supported strongly enough by the available evidence that additional diagnostic work is not reasonably necessary before planning remediation.

Do not promote a hypothesis to established root cause merely because it fits the symptoms.

## Process

### 1. Understand the Reported Failure

Identify:

* the observed behavior;
* the expected behavior;
* when or under what conditions the failure occurs;
* what component or workflow appears to be involved;
* what evidence has already been supplied.

Preserve the distinction between what the reporter observed and what is inferred from those observations.

Do not reinterpret vague symptoms as more precise facts than the evidence supports.

For example:

> "Saving sometimes fails"

does not establish:

> "The database transaction intermittently fails."

The latter is a hypothesis until supported by evidence.

### 2. Inspect the Relevant Codebase

Inspect enough of the codebase to understand the execution path involved in the failure.

Depending on the bug, this may include:

* entry points;
* call sites;
* stack-trace locations;
* interfaces and implementations;
* domain models;
* API contracts;
* persistence;
* configuration;
* error handling;
* logging;
* frontend state;
* concurrency or asynchronous behavior;
* external integrations;
* tests;
* generated code;
* recent or adjacent implementations.

Trace the relevant control flow and data flow rather than reasoning from filenames alone.

Prefer evidence from the actual implementation over assumptions based on common patterns.

Do not modify production code while diagnosing the bug.

### 3. Build the Evidence Set

Record evidence that materially constrains the diagnosis.

Evidence may include:

* reproducible behavior;
* exact error messages;
* stack traces;
* logs;
* diagnostic command output;
* database state;
* API requests and responses;
* configuration values;
* code paths;
* test behavior;
* environmental differences;
* timing or ordering information.

Summarize evidence rather than dumping large volumes of raw output when only a portion is diagnostically relevant.

Preserve exact identifiers, error messages, values, or excerpts when their exact form matters.

Do not treat absence of evidence as evidence of absence unless the diagnostic method establishes that conclusion.

### 4. Identify Active Hypotheses

Develop one or more plausible explanations for the observed behavior when the root cause is not yet established.

For each meaningful hypothesis, consider:

* what evidence supports it;
* what evidence contradicts it;
* what observations it predicts;
* how it differs from competing hypotheses.

Do not generate a large list of speculative possibilities merely because they are theoretically possible.

Prefer a small set of hypotheses that are consistent with the actual evidence and architecture.

Rank diagnostic attention by plausibility and discriminatory value, but do not present an unsupported hypothesis as established fact.

### 5. Choose Diagnostic Steps

When additional evidence is necessary, recommend diagnostics that distinguish between active hypotheses or establish an important missing fact.

Prefer diagnostics with high information value.

A useful diagnostic should answer a specific question such as:

* Does execution reach this branch?
* What value is present at this boundary?
* Which implementation is actually being resolved?
* Is the malformed value introduced before or after serialization?
* Does the failure occur before or after the transaction commits?
* Is the problem specific to one environment?
* Does the external service return the unexpected value, or does local transformation introduce it?

Avoid broad diagnostics such as:

> Add more logging everywhere.

Prefer:

> Log the value of `patientId` immediately before `CreateBundle()` and immediately after deserialization to determine which side of that boundary introduces the malformed value.

### 6. Prefer Discriminating Diagnostics

When multiple hypotheses are plausible, choose diagnostics that can distinguish among them.

For example, if:

* H1 predicts `value` is already invalid when received;
* H2 predicts local transformation corrupts `value`;

then inspecting `value` immediately before and after the transformation is more useful than adding unrelated logging elsewhere.

Prefer a small number of targeted diagnostics over a large diagnostic checklist.

Sequence diagnostics when the result of one determines whether another is necessary.

### 7. Incorporate New Diagnostic Results

When the invoking prompt supplies new diagnostic output, reconcile it with the entire current diagnosis.

For each active hypothesis, determine whether the new evidence:

* supports it;
* weakens it;
* disproves it;
* leaves it unresolved.

Remove disproven or irrelevant hypotheses.

Remove diagnostic steps that have already served their purpose.

Add new diagnostics only when meaningful uncertainty remains.

Rewrite affected sections so the bug document describes the **current diagnostic state**.

Do not preserve a chronological record such as:

> First we thought X, then diagnostic A showed Y, then we considered Z...

Prefer:

> Evidence shows Y. The remaining plausible explanation is Z.

Historical diagnostic reasoning belongs in version-control history, not the current bug ticket.

### 8. Establish Root Cause

Declare an established root cause only when the evidence adequately explains:

* the observed failure;
* the relevant execution path;
* and, where important, why the failure occurs under the reported conditions.

The root cause should identify the underlying defect rather than merely restating the immediate error.

For example:

Weak:

> `NullReferenceException` occurs because `patient` is null.

Stronger:

> `PatientRepository.GetByExternalId()` returns `null` when no mapping exists, but `ImportService.ProcessPatient()` assumes the mapping always exists and dereferences the result before the existing "unmapped patient" handling is reached.

Do not require absolute certainty when the evidence is already sufficient for responsible remediation.

Do not continue inventing diagnostics merely because additional evidence could theoretically be collected.

### 9. Propose Remediation

Propose a fix only when the current evidence supports doing so.

The remediation should address the established root cause rather than merely suppressing the symptom.

When multiple remediations would fix the defect, prefer the maintainable shape: clear ownership,
reuse of existing patterns, and a small reusable primitive when that is the durable fix -- not a
symptom-local special-case that leaves the design worse. Prefer a slightly larger maintainable fix
over a smaller brittle patch when both address the root cause. Speculative abstractions for
hypothetical future needs remain forbidden.

Static maintainability metrics (e.g., cyclomatic complexity, Sonar-style scores) may inform human
review but must not drive the remediation. Do not recommend breaking up cohesive logic solely to
appease a metric.

For each affected file or component, explain:

* why it is affected;
* what should change;
* important interactions or constraints;
* relevant error or edge-case behavior.

If the root cause is not yet established, avoid presenting speculative fixes as recommendations.

When useful, a hypothesis may include a likely remediation **conditional on that hypothesis being confirmed**, but clearly label it as conditional.

### 10. Define Manual Verification Criteria

Describe the observable outcomes a human should verify after remediation.

These are **manual verification criteria**, not instructions for the LLM to perform verification.

Where relevant, include:

* reproduction of the original failing scenario;
* expected successful behavior;
* expected error behavior;
* important boundary conditions;
* nearby existing behavior that should remain unchanged.

Do not claim that the bug has been fixed or verified.

## Bug Document Structure

Use the following structure where applicable.

Sections that genuinely do not apply may be omitted. Do not create empty or ceremonial sections.

```markdown
# BUG-XX: Short Summary

## Observed Behavior

Describe what has actually been observed.

Include relevant reproduction conditions when known.

## Expected Behavior

Describe what should happen instead.

## Evidence

- Relevant observed fact.
- Relevant log or error.
- Relevant codebase finding.

## Active Hypotheses

### H1: Short hypothesis

**Supporting evidence**
- ...

**Contradicting evidence**
- ...

**Diagnostic**
- Targeted step that would confirm, weaken, or disprove this hypothesis.

### H2: Short hypothesis

...

## Next Diagnostic Steps

1. Perform the highest-value diagnostic.
2. Perform this diagnostic only if the previous result leaves the corresponding uncertainty unresolved.

## Established Root Cause

Describe the root cause once supported by the evidence.

Omit this section while the root cause remains unknown.

## Proposed Resolution

Describe the remediation once justified by the established diagnosis.

### `path/to/file.ext`

Explain why this file is affected and what should change.

## Manual Verification

- Reproduce the original scenario.
- Describe the expected observable result.
```

The exact organization may vary when another structure communicates the diagnostic state more clearly.

## Diagnostic States

A bug ticket will commonly be in one of three states.

### Investigating

The root cause is unknown.

The document should emphasize:

* evidence;
* active hypotheses;
* discriminating diagnostics.

A proposed resolution generally should not be presented as established work yet.

### Root Cause Established

The evidence sufficiently identifies the defect.

The document should emphasize:

* evidence supporting the conclusion;
* established root cause;
* proposed remediation.

Remove obsolete hypotheses and diagnostics.

### Remediation Planned

The root cause is established and the necessary implementation changes are sufficiently understood.

The document should emphasize:

* established root cause;
* remaining implementation work;
* manual verification criteria.

Diagnostic sections that are no longer useful should be removed.

Do not preserve sections merely because earlier versions of the ticket contained them.

## Handling Supplied Explanations

The invoking user may provide a suspected cause or proposed fix.

Treat it according to its evidentiary status.

A user-provided statement such as:

> I think the cache is returning stale values.

is a hypothesis unless supporting evidence establishes it.

A user-provided statement such as:

> I logged the value before and after the cache call. It is current before the call and stale in the returned cache entry.

is evidence that should materially update the diagnosis.

Do not reject user hypotheses merely because they are unproven. Investigate them alongside other plausible explanations.

Do not automatically accept them as established facts.

## Tests and Existing Diagnostics

Existing tests may provide useful diagnostic evidence.

Use them to understand:

* intended behavior;
* known edge cases;
* where behavior diverges;
* whether a suspected path is already covered.

Do not equate a passing test suite with absence of a bug.

Do not equate a failing test with proof of a particular root cause.

Do not perform final bug verification.

## Scope Discipline

Diagnose the reported bug.

Do not turn the investigation into a general refactoring review.

Adjacent defects may be mentioned when they materially affect the diagnosis or remediation, but do not expand the ticket to unrelated cleanup.

Do not propose speculative architectural improvements merely because the affected code could be designed differently.

Prefer the smallest *maintainable* remediation that correctly addresses the established root cause
and fits the existing architecture. Maintainability applies to the remediation itself, not to
opportunistic cleanup outside the defect.

When shaping remediation recommendations, use this priority: (1) fix the defect and preserve
required behavior; (2) maximize maintainability and readability of the fix; (3) only then optimize
for incidental preferences.

If diagnosis reveals that the apparent local bug is actually caused by a broader architectural issue, document that conclusion when supported by evidence.

## Updating Existing Bug Tickets

When updating an existing bug ticket with new diagnostic information:

1. Read the existing ticket.
2. Inspect the relevant current code.
3. Incorporate the new evidence.
4. Re-evaluate active hypotheses.
5. Remove disproven hypotheses.
6. Remove completed diagnostic steps.
7. Update or remove remaining diagnostics.
8. Establish the root cause if the evidence now supports it.
9. Add or update the proposed resolution if justified.
10. Rewrite the document as a current-state diagnosis rather than appending a diagnostic history.

Do not preserve obsolete sections.

Do not add sections such as:

* Diagnostic History;
* Previous Hypotheses;
* Earlier Findings;
* Changes Since Last Investigation.

Version control already provides that history.

## Output

Create or update the bug document at the path specified by the invoking prompt.

If additional diagnostics are required, make the next diagnostic steps concrete and targeted.

If the root cause is established, make that conclusion explicit and describe the proposed remediation.

If the evidence is insufficient to determine the root cause, say so in the ticket rather than guessing.

Do not implement the fix.

Do not perform final bug verification.

Do not modify unrelated files.

## Review Discipline

Be investigative without being speculative.

Prefer evidence over intuition.

Prefer targeted diagnostics over broad data collection.

Prefer diagnostics that distinguish competing hypotheses.

Do not confuse correlation with causation.

Do not promote repeated observations into a causal explanation without justification.

Do not keep disproven hypotheses for historical completeness.

Do not continue diagnosing after the root cause is sufficiently established.

Do not propose a fix merely because it is plausible.

Do not require certainty beyond what is necessary for responsible remediation.

The central questions are:

> What do we actually know?

> What explanations remain consistent with that evidence?

> What is the smallest diagnostic step that would most reduce the remaining uncertainty?

and, once sufficient evidence exists:

> What underlying defect best explains the observed behavior, and what change directly addresses it
> in a maintainable way?
