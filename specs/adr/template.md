# NNNN: <decision summary>

- Status: Draft | Active | Superseded
- Date: YYYY-MM-DD
- Owner: <name or role; optional>

## Context

The problem, constraint, or trigger that makes a decision necessary. Reference measured evidence
or prior work instead of repeating it. Keep it short: this section is for what a reader needs to
understand the decision, not a full investigation.

## Decision

The selected direction in one or two sentences. Active means the current chosen direction, not
completed implementation and not formal external approval.

## Invariants / constraints

- What the decision commits the system to: behaviors that must always hold.
- Constraints that limit implementation freedom.
- Reference the detailed invariant set here instead of duplicating it.

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| <option> | <reason> |

## Consequences

Positive:

- <benefit>
- <benefit>

Negative:

- <cost or risk>
- <cost or risk>

## Follow-up artifacts

- Technical spec: <relative path> - owns implementation design, migration, phases, tests, and
  open questions. The ADR owns the durable decision only.
- Canonical architecture docs: <relative path or none> - updated when implementation changes
  reality, not when this ADR is written.

## Supersession

- Supersedes: <NNNN link, or none>
- Superseded by: <NNNN link, or none>

Normally none at creation. When a later ADR replaces this direction, mark this ADR Superseded and
keep both links so history reads both ways.
