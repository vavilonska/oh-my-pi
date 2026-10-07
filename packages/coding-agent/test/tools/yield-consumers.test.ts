import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { finalizeSubprocessOutput, SUBAGENT_WARNING_SCHEMA_OVERRIDDEN } from "../../src/task/executor";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import type { ToolSession } from "../../src/tools";
import { buildOutputValidator } from "../../src/tools/output-schema-validator";
import { resetYieldTurnState, YieldTool } from "../../src/tools/yield";
import type { StructuredSubagentSchemaMode, YieldItem } from "@oh-my-pi/pi-tui/tools/task";

function session(outputSchema: unknown): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		outputSchema,
	};
}

async function submit(tool: YieldTool, args: Record<string, unknown>, terminal: boolean): Promise<YieldItem> {
	const result = await tool.execute("consumer-fixture", args);
	const handler = subprocessToolRegistry.getHandler("yield");
	if (!handler?.extractData || !handler.shouldTerminate) throw new Error("yield registration unavailable");
	// Match the subprocess JSONL boundary, including omitted undefined fields.
	const event = JSON.parse(
		JSON.stringify({ toolName: "yield", toolCallId: "consumer-fixture", args, result, isError: false }),
	);
	expect(handler.shouldTerminate(event)).toBe(terminal);
	const item = handler.extractData(event);
	expect(item).toBeDefined();
	return item as YieldItem;
}

function finalize(items: YieldItem[], outputSchema: unknown, mode?: StructuredSubagentSchemaMode) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: items,
		outputSchema,
		outputSchemaMode: mode,
		outputSchemaSource: "caller",
	});
}

const findingSchema = {
	type: "object",
	properties: { title: { type: "string" }, detail: { type: "string" } },
	required: ["title"],
	additionalProperties: false,
};
const schema = {
	type: "object",
	properties: { findings: { type: "array", items: findingSchema }, note: { type: "string" } },
	required: ["findings", "note"],
	additionalProperties: false,
};

describe("yield core production consumers", () => {
	it("flattens a legal batch after a single item through registry and executor", async () => {
		const tool = new YieldTool(session(schema));
		const items = [
			await submit(tool, { type: ["findings"], data: { title: "one", detail: null } }, false),
			await submit(tool, { type: ["findings"], data: [{ title: "two" }, { title: "three" }] }, false),
			await submit(tool, { type: ["note"], data: "done" }, false),
			await submit(tool, { type: "result" }, true),
		];
		const output = finalize(items, schema);
		expect(output.exitCode).toBe(0);
		expect(output.structuredOutput?.status).toBe("valid");
		expect(JSON.parse(output.rawOutput)).toEqual({
			findings: [{ title: "one" }, { title: "two" }, { title: "three" }],
			note: "done",
		});
	});

	it("splits multi-label object values instead of broadcasting the wrapper", async () => {
		const tool = new YieldTool(session(schema));
		const sections = await submit(
			tool,
			{ type: ["findings", "note"], data: { findings: [{ title: "one", detail: null }], note: "summary" } },
			false,
		);
		const terminal = await submit(tool, { type: "result" }, true);
		const output = finalize([sections, terminal], schema);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [{ title: "one" }], note: "summary" });
	});

	it("prefers a valid nested array item and a same-label item field over wrappers", async () => {
		const nested = {
			type: "object",
			properties: {
				matrix: { type: "array", items: { type: "array", items: { type: "number" } } },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: { findings: { type: "string" } },
						required: ["findings"],
						additionalProperties: false,
					},
				},
			},
			required: ["matrix", "findings"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(nested));
		const items = [
			await submit(tool, { type: ["matrix"], data: [1, 2] }, false),
			await submit(tool, { type: ["matrix"], data: [[3], [4, 5]] }, false),
			await submit(tool, { type: ["findings"], data: { findings: "item field" } }, false),
			await submit(tool, { type: "result" }, true),
		];
		const output = finalize(items, nested);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({
			matrix: [[1, 2], [3], [4, 5]],
			findings: [{ findings: "item field" }],
		});
	});

	it("preserves a required null declared by a different allOf branch and rejects it at the final consumer", async () => {
		const combined = {
			type: "object",
			allOf: [{ properties: { note: { type: "string" } } }, { required: ["note"] }],
		};
		const validator = buildOutputValidator(combined).validator;
		expect(validator?.normalize({ note: null })).toEqual({ note: null });
		const tool = new YieldTool(session(combined));
		await expect(tool.execute("required-null", { data: { note: null } })).rejects.toThrow(/does not match schema/);
		const output = finalize([{ status: "success", data: { note: null } }], combined);
		expect(output.exitCode).toBe(1);
		expect(output.structuredOutput?.status).toBe("invalid");
	});

	it("combines section item schemas across allOf and retains final whole-array constraints", async () => {
		const combined = {
			type: "object",
			allOf: [
				{
					properties: {
						rows: {
							type: "array",
							minItems: 2,
							items: {
								type: "object",
								properties: { title: { type: "string" }, detail: { type: "string" } },
								required: ["title"],
							},
						},
					},
				},
				{
					properties: { rows: { type: "array", items: { type: "object", required: ["detail"] } } },
					required: ["rows"],
				},
			],
		};
		const tool = new YieldTool(session(combined));
		await expect(tool.execute("missing-detail", { type: ["rows"], data: { title: "missing" } })).rejects.toThrow(
			/does not match schema/,
		);
		const first = await submit(tool, { type: ["rows"], data: { title: "one", detail: "required" } }, false);
		expect(finalize([first], combined).exitCode).toBe(1);
		const second = await submit(tool, { type: ["rows"], data: [{ title: "two", detail: "required" }] }, false);
		const terminal = await submit(tool, { type: "result" }, true);
		expect(finalize([first, second, terminal], combined).exitCode).toBe(0);
	});
});

describe("yield local terminal patch consumers", () => {
	it("replaces explicit arrays including empty arrays and retains omitted scalar fields", async () => {
		const tool = new YieldTool(session(schema));
		const sections = await submit(
			tool,
			{ type: ["findings", "note"], data: { findings: [{ title: "obsolete" }], note: "retain" } },
			false,
		);
		const terminal = await submit(tool, { type: "result", data: { findings: [] } }, true);
		const output = finalize([sections, terminal], schema);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [], note: "retain" });
	});

	it("replaces only the top-level object field rather than deep-merging its old children", async () => {
		const nested = {
			type: "object",
			properties: {
				meta: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					additionalProperties: false,
				},
				note: { type: "string" },
			},
			required: ["meta", "note"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(nested));
		const sections = await submit(
			tool,
			{ type: ["meta", "note"], data: { meta: { a: 1, b: 2 }, note: "retain" } },
			false,
		);
		const terminal = await submit(tool, { data: { meta: { a: 3 } } }, true);
		const output = finalize([sections, terminal], nested);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ meta: { a: 3 }, note: "retain" });
	});

	it("validates the complete accumulation before terminal acceptance and keeps rejected patches out of state", async () => {
		const tool = new YieldTool(session(schema));
		const section = await submit(tool, { type: ["findings"], data: { title: "one" } }, false);
		await expect(tool.execute("incomplete", { type: "result" })).rejects.toThrow(/does not match schema/);
		await expect(tool.execute("null-note", { data: { note: null } })).rejects.toThrow(/does not match schema/);
		const terminal = await submit(tool, { data: { note: "repaired" } }, true);
		const output = finalize([section, terminal], schema);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [{ title: "one" }], note: "repaired" });
		resetYieldTurnState(tool);
		await expect(tool.execute("new-turn", { type: "result" })).rejects.toThrow(/requires structured output/);
		await expect(tool.execute("no-inherit", { data: { note: "new" } })).rejects.toThrow(/does not match schema/);
	});

	for (const mode of [undefined, "permissive", "strict"] as const) {
		it(`removes explicit optional null from cumulative patches in ${mode ?? "default"} mode`, async () => {
			const optional = {
				type: "object",
				properties: { status: { type: "string" }, note: { type: "string" }, receipt: { type: ["string", "null"] } },
				required: ["status"],
				additionalProperties: false,
			};
			const tool = new YieldTool(session(optional));
			const section = await submit(
				tool,
				{ type: ["status", "note"], data: { status: "done", note: "remove" } },
				false,
			);
			const terminal = await submit(tool, { data: { note: null, receipt: null } }, true);
			const output = finalize([section, terminal], optional, mode);
			expect(output.exitCode).toBe(0);
			expect(output.structuredOutput?.status).toBe("valid");
			expect(output.structuredOutput?.data).toEqual({ status: "done", receipt: null });
			expect(JSON.parse(output.rawOutput)).toEqual({ status: "done", receipt: null });
			// Normalization does not remove required nulls or waive the complete output schema.
			const invalid = finalize([section, { status: "success", data: { status: null, note: null } }], optional, mode);
			expect(invalid.exitCode).toBe(1);
			expect(invalid.structuredOutput?.status).toBe("invalid");
		});
	}

	it("requires explicit repair of retained override provenance even when normalization would drop the bad field", async () => {
		const optional = {
			type: "object",
			properties: { status: { type: "string" }, note: { type: "string" } },
			required: ["status"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(optional));
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(tool.execute("bad-section", { type: ["note"], data: { note: null } })).rejects.toThrow(
				/does not match schema/,
			);
		}
		const overridden = await submit(tool, { type: ["note"], data: { note: null } }, false);
		expect(overridden.schemaOverridden).toBe(true);
		await expect(tool.execute("retained", { data: { status: "done" } })).rejects.toThrow(/schema-overridden/);
		expect(finalize([overridden, { status: "success", data: { status: "done" } }], optional, "strict").exitCode).toBe(
			1,
		);
		for (const mode of [undefined, "permissive"] as const) {
			const retained = finalize([overridden, { status: "success", data: { status: "done" } }], optional, mode);
			expect(retained.exitCode).toBe(0);
			expect(retained.stderr).toBe(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
			expect(retained.structuredOutput?.status).toBe("invalid");
			expect(JSON.parse(retained.rawOutput)).toEqual({ status: "done" });
		}
		const terminal = await submit(tool, { data: { status: "done", note: "fixed" } }, true);
		const output = finalize([overridden, terminal], optional);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ status: "done", note: "fixed" });
	});

	it("uses only yield's non-strict Codex wire for omission without weakening the output gate", async () => {
		const tool = new YieldTool(session(schema));
		// Descriptor conversion only; no provider or model request.
		const model = buildModel({
			id: "fixture-codex",
			name: "fixture",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://fixture.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const wire = convertOpenAICodexResponsesTools([tool], model)[0];
		if (wire.type !== "function") throw new Error("expected function wire");
		expect(wire.strict).toBe(false);
		const partial = { type: "result", data: { note: "done" } };
		expect(validateJsonSchemaValue(wire.parameters, partial).success).toBe(true);
		await expect(tool.execute("incomplete-wire", partial)).rejects.toThrow(/does not match schema/);
		const section = await submit(tool, { type: ["findings"], data: [] }, false);
		const terminal = await submit(tool, partial, true);
		expect(finalize([section, terminal], schema).structuredOutput?.status).toBe("valid");
	});
});
