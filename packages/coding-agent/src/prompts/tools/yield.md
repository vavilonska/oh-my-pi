{{#if workPoolItems}}Submit ONE workpool item at a time as `{ key, data }` or `{ key, error }`: `key` is its 1-based number; `data` is the self-contained outcome/evidence value, `error` is a failure reason. The result tells you which keys remain. The final key ends the turn automatically. NEVER submit multiple items together.
{{else}}Submit subagent output: `{ data: <your output> }` for success, `{ error: "message" }` for failure. Never both; never a bare payload outside `data`.

Omit `type` for the usual single terminal structured result. Pass `type: ["section"]` to submit an incremental, non-terminal section that accumulates.
{{#if hasOutputSchema}}Section labels MUST belong to the declared schema. For one array-valued section, submit one valid item or a batch of items; an array that itself matches the item schema remains one item. A single label accepts its value directly or wrapped under that label. For multiple labels, provide an object mapping each label to its own value.
{{/if}}
{{/if}}
{{#unless workPoolItems}}
{{#if hasOutputSchema}}
This task declares an output schema: the assembled terminal result MUST fully match it. With no prior sections, provide the complete result in `data`. After incremental sections, terminal object `data` replaces only explicitly supplied top-level fields; omitted fields retain their accumulated values. Replacement is not a recursive merge, and an explicit empty array clears that field. A data-less `type: "result"` finalizes accumulated sections only if the assembled result is complete and valid; it is invalid when no sections were submitted. Prose in your last turn cannot satisfy the schema.
{{else}}
Pass `type: "result"` to finalize; when `data` is omitted, your last assistant turn becomes the raw final result.
{{/if}}
{{/unless}}
