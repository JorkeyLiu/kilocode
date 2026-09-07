# Rules Contract Gap

`rules` remains a normative registered typed-asset class in the Kilo configuration contract. The current opencode effective snapshot does not materialize `rules` assets into `instructions` or another runtime input.

This is an explicit deferred contract gap, not a retained compatibility reader.

## Canonical registration

Canonical rules assets remain registered under the canonical `.kilo` asset layout:

- global: `${Global.Path.config}/rules/`
- project/worktree: `canonicalRoot/.kilo/rules/`

The registered location must not be interpreted as evidence that the current opencode effective snapshot consumes the files.

## Deferred implementation

Rules materialization remains unresolved and is deferred. Any future implementation must define the effective snapshot contract, source precedence, file-read trust boundary, and transport evidence before adding a loader.
