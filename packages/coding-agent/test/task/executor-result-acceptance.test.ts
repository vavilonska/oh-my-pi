/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	AgentSession,
	type AgentSessionEvent,
	type IrcWakeTurnObservation,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	attachIrcWakeTurnMonitor,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPool } from "@oh-my-pi/pi-coding-agent/task/workpool";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** End an assistant message carrying `text` and no tool calls. */
	emitAssistantText: (text: string) => void;
	/** The observer factory installed by {@link attachIrcWakeTurnMonitor}, if any. */
	wakeObserver: () =>
		| ((records: AgentMessage[]) => IrcWakeTurnObservation | undefined)
		| undefined;
}

/**
 * Minimal session that satisfies the executor's run surface. `prompt` submits a
 * terminal `yield` (so `runSubprocess` / `runSubagentFollowUpTurn` settle), and
 * `subscribeRunState` never fires — the run-state mirror omits `idle`, which is
 * exactly the leak the acceptance boundary must cover.
 */
function createHarness(options?: { hangPrompt?: boolean; asyncJobManager?: AsyncJobManager }): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let wakeObserver: ((records: AgentMessage[]) => IrcWakeTurnObservation | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantText = (text: string) => {
		const message = assistantStopMessage(text);
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};
	const emitTerminalYield = (data: unknown) => {
		yieldSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${yieldSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};
	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		registerTaskRunMonitor: () => () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptEntered.resolve();
			if (options?.hangPrompt) {
				await hangingPrompt.promise;
				return true;
			}
			emitAssistantText("submitting");
			emitTerminalYield({ report: text });
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => IrcWakeTurnObservation | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		emitTerminalYield,
		emitAssistantText,
		wakeObserver: () => wakeObserver,
	};
}

function registerRunning(session: AgentSession) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		session,
		status: "running",
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** Real session/IRC/agent-loop entrypoints; only the provider responses are scripted. */
async function createLiveWakeHarness(responses: MockResponseSource, structured = false) {
	const tempDir = TempDir.createSync("@omp-injected-wake-");
	const artifactsDir = tempDir.path();
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "test-key");
	const mock = createMockModel({ provider: "openai", id: "gpt-test", responses });
	const manager = new AsyncJobManager({});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		"launch.enabled": false,
		"task.maxConcurrency": 1,
		"task.maxRuntimeMs": 0,
		"eval.workpool.freshAgents": false,
	});
	settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
	const liveSession: { current?: AgentSession } = {};
	const tools: AgentTool[] = structured
		? [
				new YieldTool({
					cwd: artifactsDir,
					settings,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					getWorkPoolYieldItems: () => liveSession.current?.getWorkPoolYieldItems() ?? [],
				}),
			]
		: [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(artifactsDir),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		agentId: AGENT_ID,
		ownedAsyncJobManager: manager,
	});
	liveSession.current = session;
	session.sessionManager.getArtifactsDir = () => artifactsDir;
	const registry = AgentRegistry.global();
	const parentMessages: string[] = [];
	const parentSession = createHarness().session;
	parentSession.sessionManager.getArtifactsDir = () => artifactsDir;
	registry.register({
		id: "Parent",
		displayName: "Parent",
		kind: "main",
		session: Object.assign(parentSession, {
			deliverIrcMessage: async (message: IrcMessage) => {
				parentMessages.push(message.body);
				return "injected" as const;
			},
		}),
		status: "running",
	});
	registry.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: "Parent",
		session,
		status: "idle",
	});
	attachIrcWakeTurnMonitor(session, { id: AGENT_ID, agent: baseAgent, structured, artifactsDir });
	const accepted = '{"report":"accepted verdict"}';
	await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
	await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
	const delivered: string[] = [];
	manager.registerDeliverySink("Parent", (_jobId, text) => {
		delivered.push(text);
	});
	const parent = {
		cwd: artifactsDir,
		settings,
		agentRegistry: registry,
		asyncJobManager: manager,
		getAgentId: () => "Parent",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return {
		session,
		manager,
		mock,
		parent,
		artifactsDir,
		parentMessages,
		delivered,
		accepted,
		artifact: () => Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text(),
		sidecar: () => Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text(),
		sidecarExists: () => Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).exists(),
		send: (from: string, body: string) => IrcBus.global().send({ from, to: AGENT_ID, body }),
		async dispose() {
			await session.abort();
			await session.waitForIdle();
			await session.waitForIrcReplies();
			await session.dispose();
			await manager.dispose({ timeoutMs: 1000 });
			authStorage.close();
			InternalUrlRouter.resetForTests();
			resetRegisteredArtifactDirsForTests();
			tempDir.removeSync();
		},
	};
}

describe("runSubprocess result acceptance", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("terminalizes the ref and stamps the run lifecycle when the yield is accepted", async () => {
		const harness = createHarness();
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(AgentRegistry.global().staleAcceptedRuns()).toEqual([]);
		// Launch milestone is the registration timestamp the acceptance must not move.
		expect(settled?.createdAt).toBe(ref.createdAt);
	});

	it("settles the owning task job when Agent Hub tombstones a running subagent", async () => {
		const harness = createHarness({ hangPrompt: true });
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const delivered = Promise.withResolvers<{ id: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: (id, text) => delivered.resolve({ id, text }),
		});
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id: AGENT_ID,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});

		try {
			await harness.promptEntered;
			await harness.session.abort();
			await AgentLifecycleManager.global().release(AGENT_ID, ref, { tombstone: true });

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await flushMicrotasks();
			const settlement = job!.status === "running" ? ("still-running" as const) : ("settled" as const);
			if (settlement === "still-running") manager.cancel(jobId);
			await job!.promise;

			expect(settlement).toBe("settled");
			expect(job!.status).toBe("failed");
			expect(await delivered.promise).toMatchObject({ id: jobId });
		} finally {
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("terminalizes an existing ref on a follow-up turn whose run-state mirror omits idle", async () => {
		const harness = createHarness();
		registerRunning(harness.session);

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("terminalizes the ref when an autonomous wake turn's yield is accepted", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		expect(observer).toBeDefined();

		const finish = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		expect(finish).toBeDefined();
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.finish(undefined);

		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("delivers every yield of a woken agent to its parent as a job completion", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			for (const report of ["followup-done", "broadcast-ok"]) {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "follow up",
						display: false,
						details: { id: `msg-${report}`, from: "Parent", message: "follow up" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				harness.emitTerminalYield({ report });
				// Pending from acceptance until finalization: the parent's `wait` can block on it.
				expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
				await finish?.finish(undefined);
				await manager.waitForAll();
				await manager.drainDeliveries({ timeoutMs: 1000 });
			}

			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain("followup-done");
			expect(delivered[1]).toContain("broadcast-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("reads the latest message-result completion after an IRC wake instead of the first result", async () => {
		const tempDir = TempDir.createSync("@omp-latest-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, {
			id: AGENT_ID,
			agent: baseAgent,
			structured: false,
			artifactsDir,
		});
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const reader = new ReadTool({
			cwd: artifactsDir,
			hasUI: false,
			getArtifactsDir: () => artifactsDir,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});

		try {
			// A completed first run left a structured payload on disk.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), '{"reports":[{"verdict":"round-1"}]}');
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), '{"reports":[{"verdict":"round-1"}]}');
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "review the revised patch",
					display: false,
					details: { id: "msg-revised", from: "Parent", message: "review the revised patch" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText('{"reports":[{"verdict":"round-2"}]}');
			await finish?.finish(undefined);
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe('{"reports":[{"verdict":"round-2"}]}');
			const read = await reader.execute("latest-result", { path: `agent://${AGENT_ID}` });
			expect(read.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("round-2") })]),
			);
			expect(JSON.stringify(read.content)).not.toContain("round-1");
			// The previous structured sidecar must not shadow the new message result.
			const extracted = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}/reports/0/verdict`);
			expect(extracted.content).toBe("round-2");
		} finally {
			InternalUrlRouter.resetForTests();
			resetRegisteredArtifactDirsForTests();
			tempDir.removeSync();
		}
	});

	it("preserves the accepted message result and sidecar when a peer wakes the agent", async () => {
		const tempDir = TempDir.createSync("@omp-peer-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "is line 42 fine?",
					display: false,
					details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText("line 42 is fine");
			await finish?.finish(undefined);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			tempDir.removeSync();
		}
	});

	it("delivers a user-resumed message result when all execution slots are occupied", async () => {
		const tempDir = TempDir.createSync("@omp-user-resumed-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const blocker = Promise.withResolvers<string>();
		manager.register("bash", "busy", () => blocker.promise, { ownerId: "Other" });
		expect(manager.atCapacity).toBe(true);
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			// The initial run died on a provider error before reporting.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), "");
			const finish = observer([
				{
					role: "user",
					content: "credits are back, finish the report",
					attribution: "user",
					timestamp: Date.now(),
				},
			]);
			harness.emitAssistantText("## Report\nroot cause found");
			await finish?.finish(undefined);
			expect(manager.atCapacity).toBe(true);
			await manager.drainDeliveries({ timeoutMs: 1000 });
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe("## Report\nroot cause found");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("root cause found");
		} finally {
			InternalUrlRouter.resetForTests();
			blocker.resolve("finished");
			resetRegisteredArtifactDirsForTests();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("keeps the accepted artifact and sidecar when the parent cancels its wake job before finalization", async () => {
		const tempDir = TempDir.createSync("@omp-cancelled-wake-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "recheck",
					display: false,
					details: { id: "msg-owner", from: "Parent", message: "recheck" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText("cancelled answer");
			expect(manager.cancel(AGENT_ID)).toBe(true);
			await finish?.finish(undefined);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("keeps the accepted artifact and sidecar when an unstructured follow-up starts aborted", async () => {
		const tempDir = TempDir.createSync("@omp-aborted-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		registerRunning(harness.session);
		vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			harness.emitAssistantText("cancelled replacement");
			return true;
		});
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const result = await runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: baseAgent,
				message: "continue",
				structured: false,
				artifactsDir,
				signal: AbortSignal.abort("cancelled"),
			});
			expect(result.aborted).toBe(true);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			tempDir.removeSync();
		}
	});

	it.each([true, false])(
		"reports an IRC-only wake accurately to the parent (already messaged: %s)",
		async alreadyMessaged => {
			const manager = new AsyncJobManager({});
			const harness = createHarness({ asyncJobManager: manager });
			const registry = AgentRegistry.global();
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "main",
				session: createHarness().session,
				status: "running",
			});
			registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "idle",
			});
			attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");
			const parent = {
				cwd: "/tmp",
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Parent",
			} as unknown as ToolSession;

			try {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "report your findings",
						display: false,
						details: { id: "msg-report", from: "Parent", message: "report your findings" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				if (alreadyMessaged) {
					const bus = IrcBus.global();
					const reply = bus.wait("Parent", { from: AGENT_ID }, 1000);
					const receipt = await bus.send({ from: AGENT_ID, to: "Parent", body: "Found the cause." });
					expect(receipt.outcome).not.toBe("failed");
					expect((await reply)?.body).toBe("Found the cause.");
				}
				const waiting = new WaitTool(parent).execute("parent-wait", {});
				// No yield or assistant prose: only the optional IRC message above.
				await finish?.finish(undefined);
				const result = await waiting;
				const job = result.details?.jobs?.[0];
				expect(job?.status).toBe("completed");
				expect(job?.resultText).toContain(`history://${AGENT_ID}`);
				if (alreadyMessaged) {
					expect(job?.resultText).not.toContain("produced no output");
					expect(job?.resultText).toContain(`${AGENT_ID} sent a message during this turn`);
				} else {
					expect(job?.resultText).toContain("produced no output");
				}
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);

	it("blocks the parent's wait on a turn its message woke and returns the turn's answer once", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "fix the mask path too",
					display: false,
					details: { id: "msg-mask", from: "Parent", message: "fix the mask path too" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			// A conversational answer: the turn ends without a yield.
			harness.emitAssistantText("mask path fixed too");
			await finish?.finish(undefined);

			const result = await waiting;
			expect(result.details?.jobs?.[0]).toMatchObject({
				id: AGENT_ID,
				status: "completed",
				resultText: "mask path fixed too",
			});
			// The job carries the answer; a relay message would deliver it twice.
			expect(IrcBus.global().take("Parent")).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
	describe("real IRC wake result publication", () => {
		it("publishes a normal idle parent wake once through automatic job delivery", async () => {
			const harness = await createLiveWakeHarness([{ content: ['{"report":"parent wake result"}'] }]);
			try {
				expect((await harness.send("Parent", "report the revised result")).outcome).toBe("woken");
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				await harness.manager.waitForAll();
				await harness.manager.drainDeliveries({ timeoutMs: 1000 });
				expect(await harness.artifact()).toBe('{"report":"parent wake result"}');
				expect(await harness.sidecarExists()).toBe(false);
				expect(harness.delivered).toHaveLength(1);
				expect(harness.delivered[0]).toContain("parent wake result");
				expect(harness.parentMessages).toEqual([]);
				expect(harness.manager.getRecentJobs(10, { ownerId: "Parent" })).toHaveLength(1);
			} finally {
				await harness.dispose();
			}
		});

		it("keeps the accepted artifact and sidecar after a peer-only conversational wake", async () => {
			const harness = await createLiveWakeHarness([{ content: ["peer conversation only"] }]);
			try {
				expect((await harness.send("Peer", "is the helper fine?")).outcome).toBe("woken");
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);
				expect(harness.manager.getRunningJobs({ ownerId: "Parent" })).toEqual([]);
				expect(harness.manager.getRecentJobs(10, { ownerId: "Parent" })).toEqual([]);
				expect(harness.delivered).toEqual([]);
			} finally {
				await harness.dispose();
			}
		});

		it.each(["peer", "queued", "async"] as const)(
			"adopts consumed parent steers in a %s turn and lets native wait consume exactly one completion",
			async entry => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const consumed = Promise.withResolvers<void>();
				const finish = Promise.withResolvers<void>();
				const harness = await createLiveWakeHarness([
					async () => {
						entered.resolve();
						await release.promise;
						return { content: ["earlier conversation"] };
					},
					async () => {
						consumed.resolve();
						await finish.promise;
						return { content: ["processing the first parent request"] };
					},
					// Steering defaults to one-at-a-time: the second parent input
					// is consumed by another provider call in this same observed run.
					{ content: ['{"report":"injected parent result"}'] },
				]);
				try {
					if (entry === "peer") {
						expect((await harness.send("Peer", "check the helper")).outcome).toBe("woken");
					} else if (entry === "queued") {
						await harness.session.steer("continue the peer discussion", undefined, { attribution: "agent" });
					} else {
						harness.manager.register("bash", "completed build", async () => "build finished", {
							id: "build-result",
							ownerId: AGENT_ID,
						});
					}
					await entered.promise;
					expect((await harness.send("Parent", "report the final revision")).outcome).toBe("injected");
					expect((await harness.send("Parent", "include the conclusion")).outcome).toBe("injected");
					// Receipt is not consumption: an already-stopped response must not
					// acquire a job/result just because the steer reached its queue.
					expect(harness.manager.getRunningJobs({ ownerId: "Parent" })).toEqual([]);
					expect(await harness.artifact()).toBe(harness.accepted);
					release.resolve();
					await consumed.promise;
					expect(JSON.stringify(harness.mock.calls[1]?.context.messages)).toContain("report the final revision");
					expect(harness.manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([
						AGENT_ID,
					]);
					const waiting = new WaitTool(harness.parent).execute("parent-wait", {});
					finish.resolve();
					const result = await waiting;
					expect(harness.mock.calls).toHaveLength(3);
					expect(JSON.stringify(harness.mock.calls[2]?.context.messages)).toContain("include the conclusion");
					expect(result.details?.jobs).toHaveLength(1);
					const job = result.details?.jobs?.[0];
					expect(job?.status).toBe("completed");
					expect(job?.resultText).toContain("injected parent result");
					await harness.session.waitForIdle();
					await harness.session.waitForIrcReplies();
					await harness.manager.drainDeliveries({ timeoutMs: 1000 });
					expect(await harness.artifact()).toContain("injected parent result");
					expect(await harness.artifact()).not.toContain("accepted verdict");
					const read = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
					expect(read.content).toContain("injected parent result");
					expect(harness.manager.getRecentJobs(10, { ownerId: "Parent" })).toHaveLength(1);
					expect(harness.manager.isJobResultConsumed(job!.id)).toBe(true);
					expect(harness.delivered).toEqual([]);
					expect(harness.parentMessages).toEqual([]);
					await expect(new WaitTool(harness.parent).execute("no-duplicate", {})).rejects.toThrow(
						"Nothing to wait for",
					);
				} finally {
					release.resolve();
					finish.resolve();
					await harness.dispose();
				}
			},
		);

		it("cancels the adopted parent turn without replacing accepted results or cancelling its successor", async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const consumed = Promise.withResolvers<void>();
			const successor = Promise.withResolvers<void>();
			const finishSuccessor = Promise.withResolvers<void>();
			const harness = await createLiveWakeHarness([
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["previous conversation"] };
				},
				() => {
					consumed.resolve();
					return { content: ["cancelled replacement"], delayMs: 60_000 };
				},
				async () => {
					successor.resolve();
					await finishSuccessor.promise;
					return { content: ["successor result"] };
				},
			]);
			try {
				await harness.session.steer("resume discussion", undefined, { attribution: "agent" });
				await entered.promise;
				expect((await harness.send("Parent", "inspect the revision")).outcome).toBe("injected");
				release.resolve();
				await consumed.promise;
				const [job] = harness.manager.getRunningJobs({ ownerId: "Parent" });
				expect(job).toBeDefined();
				const waiting = new WaitTool(harness.parent).execute("cancelled-parent-wait", {});
				expect(harness.manager.cancel(job!.id)).toBe(true);
				const cancelled = await waiting;
				expect(cancelled.details?.jobs?.[0]?.status).not.toBe("completed");
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				expect(harness.session.agent.state.isStreaming).toBe(false);
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);

				expect((await harness.send("Parent", "run a fresh revision")).outcome).toBe("woken");
				await successor.promise;
				const [nextJob] = harness.manager.getRunningJobs({ ownerId: "Parent" });
				expect(nextJob?.id).not.toBe(job!.id);
				expect(harness.manager.cancel(job!.id)).toBe(false);
				const nextWait = new WaitTool(harness.parent).execute("successor-wait", {});
				finishSuccessor.resolve();
				expect((await nextWait).details?.jobs?.[0]?.status).toBe("completed");
				await harness.session.waitForIrcReplies();
				expect(await harness.artifact()).toBe("successor result");
				expect(harness.parentMessages).toEqual([]);
			} finally {
				release.resolve();
				finishSuccessor.resolve();
				await harness.dispose();
			}
		});

		it("reports a consumed parent request's provider failure instead of accepting prior assistant prose", async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const harness = await createLiveWakeHarness([
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["old peer answer"] };
				},
				{ stopReason: "error", errorMessage: "synthetic provider failure", content: [] },
			]);
			try {
				await harness.session.steer("resume discussion", undefined, { attribution: "agent" });
				await entered.promise;
				expect((await harness.send("Parent", "finish the report")).outcome).toBe("injected");
				release.resolve();
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				await harness.manager.waitForAll();
				await harness.manager.drainDeliveries({ timeoutMs: 1000 });
				const [job] = harness.manager.getRecentJobs(10, { ownerId: "Parent" });
				expect(job?.status).toBe("failed");
				expect(harness.delivered).toHaveLength(1);
				expect(harness.delivered[0]).toContain("synthetic provider failure");
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);
			} finally {
				release.resolve();
				await harness.dispose();
			}
		});

		it.each(["follow-up", "pooled"] as const)(
			"keeps an executor-owned %s turn on its native completion when it consumes a parent steer",
			async entry => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const consumed = Promise.withResolvers<void>();
				const finish = Promise.withResolvers<void>();
				const pooled = entry === "pooled";
				const harness = await createLiveWakeHarness(
					[
						async () => {
							entered.resolve();
							await release.promise;
							return { content: ["prior assignment narration"] };
						},
						async () => {
							consumed.resolve();
							await finish.promise;
							return pooled
								? {
										content: [
											{
												type: "toolCall" as const,
												id: "pooled-result",
												name: "yield",
												arguments: { key: 1, data: { report: "native pooled result" } },
											},
										],
									}
								: { content: ["native follow-up result"] };
						},
					],
					pooled,
				);
				try {
					let pool: WorkPool | undefined;
					if (pooled) {
						pool = new WorkPool(harness.parent, {
							name: "owned-pool",
							policy: {
								discovery: { agents: [baseAgent], projectAgentsDir: null },
								agentName: baseAgent.name,
								agent: baseAgent,
								effectiveAgent: baseAgent,
								structured: true,
								schema: {
									schema: undefined,
									source: "none",
									mode: "permissive",
									outputSchemaOverridesAgent: false,
								},
								planMode: false,
								isIsolated: false,
								mergeMode: "patch",
								applyChanges: true,
								enableLsp: false,
								enableIrc: true,
							},
						});
						// Start with the kept-alive worker's first batch already
						// accepted; push must run the real second-batch path.
						pool.agents.push({ id: AGENT_ID, index: 1, state: "idle", queue: [], turns: 1 });
						pool.push(["review the next item"]);
					} else {
						harness.manager.register(
							"task",
							"explicit follow-up",
							async ({ signal }) => {
								const result = await runSubagentFollowUpTurn({
									id: AGENT_ID,
									agent: baseAgent,
									message: "review the next revision",
									structured: false,
									artifactsDir: harness.artifactsDir,
									signal,
								});
								if (result.exitCode !== 0 || result.error) throw new Error(result.error ?? result.output);
								return { text: result.output };
							},
							{ id: "native-follow-up", agentId: AGENT_ID, ownerId: "Parent" },
						);
					}
					await entered.promise;
					expect((await harness.send("Parent", "include the latest revision")).outcome).toBe("injected");
					release.resolve();
					await consumed.promise;
					const jobs = harness.manager.getRunningJobs({ ownerId: "Parent" });
					expect(jobs.map(job => job.id).sort()).toEqual(
						pooled ? [`${AGENT_ID}-b2`, "owned-pool"].sort() : ["native-follow-up"],
					);
					expect(harness.manager.getJob(AGENT_ID)).toBeUndefined();
					expect(JSON.stringify(harness.mock.calls[1]?.context.messages)).toContain("include the latest revision");
					finish.resolve();
					await harness.manager.waitForAll();
					await harness.session.waitForIdle();
					await harness.session.waitForIrcReplies();
					await harness.manager.drainDeliveries({ timeoutMs: 1000 });
					expect(harness.delivered).toHaveLength(1);
					expect(harness.delivered[0]).toContain(pooled ? "native pooled result" : "native follow-up result");
					expect(harness.manager.getJob(AGENT_ID)).toBeUndefined();
					expect(harness.parentMessages).toEqual([]);
					if (pool) {
						expect(pool.items[0]?.status).toBe("completed");
						expect(pool.agents[0]?.turns).toBe(2);
					} else {
						expect(await harness.artifact()).toBe("native follow-up result");
					}
				} finally {
					release.resolve();
					finish.resolve();
					await harness.dispose();
				}
			},
		);

		it("fails an injected parent request after empty-stop recovery without republishing earlier peer prose", async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const consumed = Promise.withResolvers<void>();
			const empty = Promise.withResolvers<void>();
			const responses: MockResponseSource = (function* () {
				yield async () => {
					entered.resolve();
					await release.promise;
					return { content: ["old peer report must not become the parent result"] };
				};
				yield async () => {
					consumed.resolve();
					await empty.promise;
					return { content: [], stopReason: "stop" as const };
				};
				// The native recovery cap, not a short script or provider exception,
				// must terminalize the repeated empty responses.
				while (true) yield { content: [], stopReason: "stop" as const };
			})();
			const harness = await createLiveWakeHarness(responses);
			try {
				expect((await harness.send("Peer", "review the old revision")).outcome).toBe("woken");
				await entered.promise;
				expect((await harness.send("Parent", "report on the new revision")).outcome).toBe("injected");
				release.resolve();
				await consumed.promise;
				const waiting = new WaitTool(harness.parent).execute("empty-stop-parent-wait", {});
				empty.resolve();
				const result = await waiting;
				expect(result.details?.jobs).toHaveLength(1);
				expect(result.details?.jobs?.[0]?.status).toBe("failed");
				expect(result.details?.jobs?.[0]?.errorText).toContain("empty stop after retry cap");
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				expect(harness.mock.calls.length).toBeGreaterThan(2);
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);
				expect(harness.delivered).toEqual([]);
				expect(harness.parentMessages).toEqual([]);
			} finally {
				release.resolve();
				empty.resolve();
				await harness.dispose();
			}
		});

		it("publishes a fresh parent result after a peer recovery failure while owned async work keeps the observation open", async () => {
			const capped = Promise.withResolvers<string | undefined>();
			const childWork = Promise.withResolvers<string>();
			const continuationEntered = Promise.withResolvers<void>();
			const releaseContinuation = Promise.withResolvers<void>();
			const parentConsumed = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			let asyncPhase = false;
			const responses: MockResponseSource = (function* () {
				while (!asyncPhase) yield { content: [], stopReason: "stop" as const };
				yield async () => {
					continuationEntered.resolve();
					await releaseContinuation.promise;
					return { content: ["async update before the parent request"] };
				};
				yield async () => {
					parentConsumed.resolve();
					await finish.promise;
					return { content: ["fresh parent result after recovery failure"] };
				};
			})();
			const harness = await createLiveWakeHarness(responses);
			harness.session.subscribe(event => {
				if (event.type === "auto_retry_end" && !event.success) capped.resolve(event.finalError);
			});
			harness.manager.register(
				"bash",
				"child work",
				({ signal }) => untilAborted(signal, childWork.promise),
				{ id: "child-work", ownerId: AGENT_ID },
			);
			try {
				expect((await harness.send("Peer", "review the earlier revision")).outcome).toBe("woken");
				expect(await capped.promise).toContain("empty stop after retry cap");
				await harness.session.waitForIdle();
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);
				expect(harness.manager.getRunningJobs({ ownerId: AGENT_ID })).toHaveLength(1);
				asyncPhase = true;
				childWork.resolve("child work finished");
				await continuationEntered.promise;
				expect((await harness.send("Parent", "report the fresh revision")).outcome).toBe("injected");
				releaseContinuation.resolve();
				await parentConsumed.promise;
				const waiting = new WaitTool(harness.parent).execute("fresh-parent-wait", {});
				finish.resolve();
				const result = await waiting;
				expect(result.details?.jobs).toHaveLength(1);
				expect(result.details?.jobs?.[0]?.status).toBe("completed");
				expect(result.details?.jobs?.[0]?.resultText).toContain("fresh parent result after recovery failure");
				expect(result.details?.jobs?.[0]?.errorText).toBeUndefined();
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				expect(await harness.artifact()).toBe("fresh parent result after recovery failure");
				expect(await harness.sidecarExists()).toBe(false);
				expect(harness.delivered).toEqual([]);
				expect(harness.parentMessages).toEqual([]);
			} finally {
				asyncPhase = true;
				childWork.resolve("child work finished");
				releaseContinuation.resolve();
				finish.resolve();
				await harness.dispose();
			}
		});

		it("retains the monitor's irreversible invalid-yield failure after consuming a parent request", async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const consumed = Promise.withResolvers<void>();
			const continueErrors = Promise.withResolvers<void>();
			let sequence = 0;
			const invalidYield = () => ({
				content: [
					{
						type: "toolCall" as const,
						name: "yield",
						arguments: { data: { report: `invalid-${++sequence}` }, error: "conflicting failure" },
					},
				],
			});
			const responses: MockResponseSource = (function* () {
				yield async () => {
					entered.resolve();
					await release.promise;
					return invalidYield();
				};
				yield async () => {
					consumed.resolve();
					await continueErrors.promise;
					return invalidYield();
				};
				while (true) yield invalidYield();
			})();
			const harness = await createLiveWakeHarness(responses, true);
			try {
				expect((await harness.send("Peer", "review the patch")).outcome).toBe("woken");
				await entered.promise;
				expect((await harness.send("Parent", "finish the report")).outcome).toBe("injected");
				release.resolve();
				await consumed.promise;
				const waiting = new WaitTool(harness.parent).execute("hard-failure-parent-wait", {});
				continueErrors.resolve();
				const result = await waiting;
				expect(result.details?.jobs).toHaveLength(1);
				expect(result.details?.jobs?.[0]?.status).toBe("failed");
				expect(result.details?.jobs?.[0]?.errorText).toContain("invalid yield results");
				await harness.session.waitForIdle();
				await harness.session.waitForIrcReplies();
				expect(await harness.artifact()).toBe(harness.accepted);
				expect(await harness.sidecar()).toBe(harness.accepted);
				expect(harness.delivered).toEqual([]);
			} finally {
				release.resolve();
				continueErrors.resolve();
				await harness.dispose();
			}
		});
	});
});
