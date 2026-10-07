import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import type { JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as judgment from "../src/judgment";
import { FindTool } from "../src/tools/jfind";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { ToolAbortError } from "../src/tools/tool-errors";
import type { ToolSession } from "../src/tools";
import type { CascadeResult } from "../src/tools/jfind/cascade";
import { type FindSearchOptions, runFindSearch } from "../src/tools/jfind/health";

const isolation = await fs.mkdtemp(path.join(os.tmpdir(), "omp-find-regression-"));
afterAll(() => fs.rm(isolation, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function emptySearch(): CascadeResult {
	return {
		hits: [],
		threshold: 0.2,
		keywords: [],
		stats: {
			listed: 0,
			requests: 0,
			errors: 0,
			judged: 0,
			filesRead: 0,
			fileBytes: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			apiMs: 0,
			windowsJudged: 0,
			windowsPruned: 0,
			mapCards: 0,
			failures: [],
		},
	};
}
async function failureOf(execution: Promise<unknown>): Promise<Error> {
	try {
		await execution;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected production consumer to reject");
}
function untilAborted(signal: AbortSignal): Promise<CascadeResult> {
	const pending = Promise.withResolvers<CascadeResult>();
	// AbortSignal.timeout need not keep a standalone runner's event loop alive.
	const keepAlive = setInterval(() => {}, 1000);
	const abort = () => {
		clearInterval(keepAlive);
		pending.reject(signal.reason);
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	return pending.promise;
}
function transportFailure(code = "ECONNRESET"): Error {
	return Object.assign(new Error("private backend text"), { code });
}

const params = { query: "exported implementation", grep_keywords: ["export"] };
async function withTool(
	run: (fixture: {
		tool: (owner?: object) => InstanceType<typeof FindTool>;
		state: { requests: number; error?: Error; wait?: (signal: AbortSignal) => Promise<void> };
	}) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(isolation, "workspace-"));
	await Bun.write(path.join(dir, "a.ts"), "export function value() { return 1; }\n");
	await Bun.write(path.join(dir, "other", "b.ts"), "export const other = 2;\n");
	const state: { requests: number; error?: Error; wait?: (signal: AbortSignal) => Promise<void> } = { requests: 0 };
	const settings = Settings.isolated();
	// No registry is read because the judge method is the only substituted seam.
	const registry = {} as ToolSession["modelRegistry"];
	const judge = new judgment.ChainJudge({ settings, registry: registry!, purpose: "test" });
	vi.spyOn(judge, "judge").mockImplementation(
		async <Q extends Questions>(
			request: JudgmentRequest<Q>,
			options: JudgeOptions = {},
		): Promise<JudgmentResult<Q>> => {
			state.requests++;
			if (state.wait && options.signal) await state.wait(options.signal);
			if (state.error) throw state.error;
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const key of Object.keys(request.questions)) answers[key] = { type: "noul", noul: 0.9 };
			return {
				api: "typesafe",
				provider: "synthetic",
				model: "synthetic",
				answers: answers as JudgmentResult<Q>["answers"],
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	);
	vi.spyOn(judgment, "resolveJudge").mockReturnValue(judge);
	vi.spyOn(judgment, "sharedJudgmentCache").mockReturnValue(undefined);
	const tool = (owner?: object) =>
		new FindTool({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			modelRegistry: registry,
			subagentEventBus: owner as ToolSession["subagentEventBus"],
		});
	try {
		await run({ tool, state });
	} finally {
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("FindTool and scoped health production consumers", () => {
	it("FindTool-normalized-sibling-scope-reuses-typed-cause", () =>
		withTool(async f => {
			f.state.error = new AggregateError(
				[Object.assign(new Error("private payload"), { status: 503 })],
				"judge chain failed",
			);
			const owner = {};
			const first = await f.tool(owner).execute("first", params);
			expect(first.isError).toBe(true);
			assert.ok(first.details, "FindTool failures include structured search statistics");
			expect(first.details.stats.requests).toBeGreaterThan(0);
			const requests = f.state.requests;
			const reused = await failureOf(f.tool(owner).execute("reuse", { ...params, path: "other/.." }));
			expect(reused.message).toContain("HTTP 503");
			expect(reused.message).toContain("did not execute semantic search");
			expect(reused.message).not.toContain("private payload");
			expect(f.state.requests).toBe(requests);
		}));
	it("FindTool-task-root-and-scope-isolation", () =>
		withTool(async f => {
			f.state.error = transportFailure();
			const owner = {};
			await f.tool(owner).execute("first", params);
			const requests = f.state.requests;
			await f.tool(owner).execute("other", { ...params, path: "other" });
			expect(f.state.requests).toBeGreaterThan(requests);
			const next = f.state.requests;
			await f.tool({}).execute("different-root", params);
			expect(f.state.requests).toBeGreaterThan(next);
			const local = f.tool();
			await local.execute("local", params);
			const localRequests = f.state.requests;
			await failureOf(local.execute("local-reuse", params));
			expect(f.state.requests).toBe(localRequests);
		}));
	it("FindTool-30s-TTL-does-not-extend-on-reuse-and-recovers", () =>
		withTool(async f => {
			let now = performance.now();
			vi.spyOn(performance, "now").mockImplementation(() => now);
			const owner = {};
			f.state.error = transportFailure();
			await f.tool(owner).execute("first", params);
			const requests = f.state.requests;
			now += 29_000;
			await failureOf(f.tool(owner).execute("reuse", params));
			expect(f.state.requests).toBe(requests);
			now += 1000;
			f.state.error = undefined;
			const recovered = await f.tool(owner).execute("recovered", params);
			expect(recovered.isError).not.toBe(true);
			assert.ok(recovered.details, "Recovered FindTool searches include structured hits");
			expect(recovered.details.hits.some((hit: { rel: string }) => hit.rel === "a.ts")).toBe(true);
			expect(f.state.requests).toBeGreaterThan(requests);
		}));
	it("FindTool-mixed-AggregateError-is-not-cached", () =>
		withTool(async f => {
			f.state.error = new AggregateError(
				[transportFailure(), Object.assign(new Error("invalid request"), { status: 400 })],
				"mixed",
			);
			const tool = f.tool({});
			await tool.execute("mixed", params);
			const requests = f.state.requests;
			await tool.execute("retry", params);
			expect(f.state.requests).toBeGreaterThan(requests);
		}));
	it("FindTool-caller-abort-does-not-poison-sibling", () =>
		withTool(async f => {
			const entered = Promise.withResolvers<void>();
			f.state.wait = async signal => {
				entered.resolve();
				await untilAborted(signal);
			};
			const owner = {};
			const controller = new AbortController();
			const cancelled = failureOf(f.tool(owner).execute("cancel", params, controller.signal));
			await entered.promise;
			controller.abort();
			expect(await cancelled).toBeInstanceOf(ToolAbortError);
			f.state.wait = undefined;
			const sibling = await f.tool(owner).execute("sibling", params);
			expect(sibling.isError).not.toBe(true);
			assert.ok(sibling.details, "Uncancelled FindTool siblings include structured hits");
			expect(sibling.details.hits.length).toBeGreaterThan(0);
		}));
	it("ChainJudge-preserves-all-candidate-causes-without-model-call", async () => {
		const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			auth.keys.setRuntime("typesafe", "isolated-key");
			const primarySpec: ModelSpec<"typesafe"> = {
				id: "isolated-primary",
				name: "Isolated",
				provider: "typesafe",
				api: "typesafe",
				baseUrl: "http://127.0.0.1:1",
				kind: "judge",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			};
			const primary = buildModel(primarySpec);
			const backup = buildModel({ ...primarySpec, id: "isolated-backup" });
			const registry = new ModelRegistry(auth, path.join(isolation, "models.yml"));
			vi.spyOn(registry, "getAvailable").mockReturnValue([primary, backup]);
			const settings = Settings.isolated({
				modelRoles: { judge: "typesafe/isolated-primary" },
				"retry.fallbackChains": { judge: ["typesafe/isolated-backup"] },
			});
			const causes = [transportFailure(), Object.assign(new Error("bad request"), { status: 400 })];
			let index = 0;
			const error = await failureOf(
				new judgment.ChainJudge({ settings, registry, purpose: "regression" }).withCandidate(async () => {
					throw causes[index++];
				}),
			);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual(causes);
			const scope = base({});
			expect(
				await failureOf(
					runFindSearch({
						...scope,
						search: async () => {
							throw error;
						},
					}),
				),
			).toBe(error);
			await runFindSearch(scope);
		} finally {
			auth.close();
		}
	});

	const base = (owner: object, scope = isolation): FindSearchOptions => ({
		owner,
		root: { type: "directory", path: scope },
		search: async () => emptySearch(),
	});
	it("health-timeout-normalization-and-observation-time", async () => {
		const owner = {};
		const observed = Date.UTC(2026, 0, 1);
		const clock = vi.spyOn(Date, "now").mockReturnValue(observed);
		const first = await failureOf(runFindSearch({ ...base(owner), timeoutMs: 1, search: untilAborted }));
		clock.mockReturnValue(observed + 1000);
		const reused = await failureOf(runFindSearch(base(owner, path.join(isolation, "child", ".."))));
		expect(first.message).toContain(new Date(observed).toISOString());
		expect(reused.message).toContain(new Date(observed).toISOString());
		expect(reused.message).toContain("did not execute semantic search");
	});
	it("health-URL-scheme-and-slash-normalization-file-isolation", async () => {
		const owner = {};
		for (const scope of ["OMP://tools/", "omp:///"])
			await failureOf(
				runFindSearch({
					...base(owner, scope),
					search: async () => {
						throw transportFailure();
					},
				}),
			);
		await failureOf(runFindSearch(base(owner, "omp://tools")));
		await failureOf(runFindSearch(base(owner, "omp://")));
		await runFindSearch(base(owner, "omp://other"));
		await runFindSearch({ ...base(owner), root: { type: "file", path: "omp://tools", size: 1 } });
		await runFindSearch(base({}, "omp://tools"));
	});
	it("health-typed-infrastructure-only-and-safe-reuse", async () => {
		for (const error of [
			transportFailure(),
			Object.assign(new Error("private"), { status: 502 }),
			Object.assign(new Error("private"), { statusCode: 504 }),
			new Error("wrapper", { cause: transportFailure("EPIPE") }),
		]) {
			const scope = base({});
			expect(
				await failureOf(
					runFindSearch({
						...scope,
						search: async () => {
							throw error;
						},
					}),
				),
			).toBe(error);
			const reused = await failureOf(runFindSearch(scope));
			expect(reused.message).toContain("did not execute semantic search");
			expect(reused.message).not.toContain("private");
		}
		for (const error of [
			new Error("network timeout"),
			Object.assign(new Error("abort"), { name: "AbortError", cause: transportFailure() }),
			...[400, 401, 429, 500].map(status => Object.assign(new Error("HTTP"), { status, cause: transportFailure() })),
			new AggregateError([transportFailure(), new Error("config")]),
			Object.assign(new AggregateError([transportFailure(), new Error("config")]), { status: 503 }),
		]) {
			const scope = base({});
			await failureOf(
				runFindSearch({
					...scope,
					search: async () => {
						throw error;
					},
				}),
			);
			await runFindSearch(scope);
		}
	});
	it("health-caller-abort-wins-deadline-and-cache", async () => {
		const scope = base({});
		const controller = new AbortController();
		const error = await failureOf(
			runFindSearch({
				...scope,
				timeoutMs: 1,
				signal: controller.signal,
				search: async signal => {
					try {
						return await untilAborted(signal);
					} finally {
						controller.abort();
					}
				},
			}),
		);
		expect(error).toBeInstanceOf(ToolAbortError);
		await runFindSearch(scope);
		await failureOf(
			runFindSearch({
				...scope,
				search: async () => {
					throw transportFailure();
				},
			}),
		);
		expect(await failureOf(runFindSearch({ ...scope, signal: controller.signal }))).toBeInstanceOf(ToolAbortError);
	});
	it("health-concurrent-cancel-and-recovery-ordering", async () => {
		const scope = base({});
		const finish = Promise.withResolvers<CascadeResult>();
		let siblingSignal: AbortSignal | undefined;
		const sibling = runFindSearch({
			...scope,
			search: signal => {
				siblingSignal = signal;
				return finish.promise;
			},
		});
		const controller = new AbortController();
		const cancelled = failureOf(runFindSearch({ ...scope, signal: controller.signal, search: untilAborted }));
		controller.abort();
		expect(await cancelled).toBeInstanceOf(ToolAbortError);
		expect(siblingSignal?.aborted).toBe(false);
		await failureOf(
			runFindSearch({
				...scope,
				search: async () => {
					throw transportFailure();
				},
			}),
		);
		await failureOf(runFindSearch(scope));
		finish.resolve(emptySearch());
		await sibling;
		await runFindSearch(scope);
		const late = Promise.withResolvers<CascadeResult>();
		const old = failureOf(runFindSearch({ ...scope, search: () => late.promise }));
		await runFindSearch(scope);
		late.reject(transportFailure());
		await old;
		await runFindSearch(scope);
	});
	it("FindTool-partial-success-does-not-poison-the-next-query", () =>
		withTool(async f => {
			const tool = f.tool({});
			f.state.wait = async () => {
				f.state.error = f.state.requests === 1 ? transportFailure() : undefined;
			};
			const partial = await tool.execute("partial", params);
			assert.ok(partial.details, "Degraded FindTool searches include structured statistics and hits");
			expect(partial.details.stats.errors).toBeGreaterThan(0);
			expect(partial.details.hits.some(hit => hit.rel === "a.ts")).toBe(true);
			const requests = f.state.requests;
			await tool.execute("retry", params);
			expect(f.state.requests).toBeGreaterThan(requests);
		}));
	it("health-mixed-observed-requests-and-direct-transport-do-not-cache", async () => {
		const scope = base({});
		await failureOf(
			runFindSearch({
				...scope,
				search: async (_signal, observe) => {
					observe(Object.assign(new Error("permanent"), { status: 400 }));
					throw transportFailure();
				},
			}),
		);
		await runFindSearch(scope);
	});
	it("health-permanent-observation-followed-by-deadline-does-not-cache", async () => {
		const scope = base({});
		await failureOf(
			runFindSearch({
				...scope,
				timeoutMs: 1,
				search: async (signal, observe) => {
					observe(new AggregateError([transportFailure(), new Error("configuration")]));
					return untilAborted(signal);
				},
			}),
		);
		await runFindSearch(scope);
	});
	it("health-all-failed-requests-require-every-typed-cause-to-qualify", async () => {
		for (const mixed of [false, true]) {
			const scope = base({});
			await runFindSearch({
				...scope,
				search: async (_signal, observe) => {
					observe(transportFailure());
					observe(mixed ? Object.assign(new Error("permanent"), { status: 401 }) : transportFailure());
					const result = emptySearch();
					result.stats.requests = 2;
					result.stats.errors = 2;
					return result;
				},
			});
			if (mixed) await runFindSearch(scope);
			else await failureOf(runFindSearch(scope));
		}
	});
	it("health-overlapping-failure-does-not-refresh-the-original-deadline", async () => {
		let now = performance.now();
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const scope = base({});
		const pending = Promise.withResolvers<CascadeResult>();
		const overlapping = failureOf(runFindSearch({ ...scope, search: () => pending.promise }));
		await failureOf(
			runFindSearch({
				...scope,
				search: async () => {
					throw transportFailure();
				},
			}),
		);
		now += 29_000;
		pending.reject(transportFailure());
		await overlapping;
		await failureOf(runFindSearch(scope));
		now += 1000;
		await runFindSearch(scope);
	});
});
