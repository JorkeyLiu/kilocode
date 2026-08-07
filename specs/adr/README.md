# Architecture Decision Records (ADR)

This directory holds Kilo's architecture decision records: short, durable documents that capture
a significant architecture decision, why it was made, what was rejected, and what direction the
system is committed to. ADRs live under `specs/adr/` as `NNNN-slug.md` files and are plain
markdown like any other spec.

An ADR answers "what did we decide and why". It is not an implementation plan, and it does not
describe the implemented system.

## When an ADR is needed

Write an ADR only for a durable architecture decision with meaningful impact on persistence,
state ownership, lifecycle, concurrency, protocols, migrations, compatibility, or comparable
system boundaries:

- How sessions are stored, how sync works, or how configuration applies.
- Reversing or narrowing a previously decided direction.
- Introducing a cross-client contract that future work must keep or migrate.
- Committing the system to an invariant set that other code must not break.

Multi-phase work where later phases depend on the direction set by the first, and decisions with
rejected alternatives that contributors are likely to re-propose, are the usual candidates. When
in doubt, write a short ADR: recording a decision is cheaper than rediscovering it later.

## When an ADR is not needed

- Ordinary bug fixes, local refactors, UI polish, and tests that preserve existing behavior.
- Implementation under an existing ADR: the technical spec owns the design and the canonical
  architecture docs own the implemented state.
- Implementation choices that do not outlive the feature that introduces them.
- Decisions fully captured by a technical spec with no durable architectural consequence.
- Product or content decisions that do not constrain the architecture.

If a change needs neither an ADR nor a technical spec, do not create either.

## Relationship to other documents

| Document | Location | Owns |
|---|---|---|
| ADR | `specs/adr/NNNN-*.md` | The durable decision: context, selected direction, rejected alternatives, consequences, invariants. Immutable once written. |
| Technical spec | `specs/` subdirectories, for example `specs/storage/` | Implementation design, migration, phased roadmap, tests, open questions. Updated as implementation evolves. |
| Canonical architecture docs | `packages/kilo-docs/pages/contributing/architecture/` | The implemented current system. Updated when implementation changes reality. |

Rules:

- An ADR never duplicates a technical spec's implementation detail (schema, protocol, phases,
  tests). If the detail is growing, it belongs in the technical spec.
- A technical spec cites its ADR for the durable decision and keeps implementation ownership.
- When implementation lands and changes what the system actually is, the canonical architecture
  docs are updated; the ADR and the technical spec are not rewritten to match implementation.
- One change can produce all three documents, each with a distinct job.

## Numbering and naming

- Sequential zero-padded number plus a short kebab-case slug: `0001-lossless-session-storage-rewriting.md`.
- One number per decision. Never reuse a number; a new decision gets a new number.
- The slug summarizes the decision, not the feature.

## Status lifecycle

| Status | Meaning |
|---|---|
| Draft | Written, not yet the chosen direction. Open for change. |
| Active | The current chosen direction. Not completed implementation, not formal external approval. |
| Superseded | Replaced by a later ADR. Kept for history; not deleted. |

Active means chosen direction, not implemented. An ADR may stay Active for a long time while a
technical spec carries the implementation. Status is manually maintained metadata: there is no
automatic transition and no approval workflow. An ADR moves from Draft to Active when the owner
or maintainers decide it is the chosen direction, and to Superseded when a later ADR replaces it.

## Immutability and supersession

- A written ADR is never edited to reflect a later change of direction.
- When a decision changes, write a new ADR with the appropriate status and mark the old one
  Superseded. Both link to each other (Supersedes / Superseded by).
- Rejected alternatives are recorded in the ADR that considered them; do not go back and edit an
  older ADR's alternatives section.
- Keep the Status field accurate, but never rewrite the body.

## Authorship and ownership

- Anyone may author an ADR. Start it as Draft.
- An ADR becomes Active when the people who own the affected area (or the user, for a
  personal-direction decision) decide it is the chosen direction. No separate approval step.
- Owner is optional metadata recording who is responsible for the decision, not a sign-off.

## Format

- Follow the repository markdown conventions: compact tables (single-space padding), ASCII
  punctuation, and the terminology used across specs (Kilo, retained sessions, event log, read
  models, workspace sync, session warp).
- Start from `template.md`. Keep an ADR short: if the rationale grows past a few paragraphs, the
  implementation detail belongs in a technical spec.

## Governance (deliberately light)

- No CI gate, no automatic status transition, no approval workflow, no docs navigation entry, no
  Feature Proposal requirement, no changeset, and no source-code change are required for an ADR.
- An ADR is a markdown file under `specs/adr/` like any other spec. It does not ship in the
  product and is not part of the public docs site.
- If a future repository convention conflicts with this one, record the conflict in the ADR text
  rather than inventing a heavier process.
