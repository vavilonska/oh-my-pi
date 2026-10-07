{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent owning a complete module: investigation, implementation, and integration. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Define interfaces and integration responsibility in {{#if batchEnabled}}`context`{{else}}the task{{/if}}.

# Verification
The module or integration owner runs the affected CLI/UI, checks, failure fixes, and cleanup; do not routinely hand execution back to the caller.
Schedule verification by interference risk: establish the check's source dependencies and shared writes/devices. MUST NOT run against changing dependencies unless reliably isolated. Isolated local diagnostics may run early.
Verify once the affected dependencies are stable; do not wait for unrelated work or repeat full suites at every phase. Re-run only what changed code, a failure, or a concrete coverage gap requires.
Non-integrating leaves hand off implementation, verification entrypoints, and remaining dependencies as ready for integration—not fully verified. Read-only roles MUST NOT execute checks.

# Inputs
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name. `outputSchema` overrides agent/session schemas.
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}`model`: selector or ordered array overriding the agent's model for this spawn (`provider/model[:level]`, role alias like `@smol`, `@default` = parent's live model){{#if batchEnabled}}; set per `tasks[]` item, never top-level{{/if}}. Omit unless a specific model is needed. Requested model unavailable → stop and report; NEVER substitute another.
`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
