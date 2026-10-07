import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("errors for a subagent whose only running work is its parent's job on it", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
		await expect(waiting).rejects.toThrow("Nothing to wait for");
		childRun.resolve("done");
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted by message." }]);
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
	});

	test("a hung daemon broker does not fail the wait; the job result still arrives", async () => {
		const hungBroker = {
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(hungBroker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager, "Main", true)).execute("wait-hung-broker", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
	});
	test("reused discovery failure expires from its original observation, not its last read", async () => {
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const broker = {
			request: vi.fn(async () => {
				throw new daemonClient.DaemonBrokerUnavailableError("Daemon list request timed out");
			}),
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		const factory = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		const tool = new WaitTool(session(undefined, "Main", true));
		await expect(tool.execute("failed", {})).rejects.toThrow("Last-known service state is not current");
		expect(factory).toHaveBeenCalledTimes(1);
		now += 59_000;
		await expect(tool.execute("reused", {})).rejects.toThrow("Reused recent broker failure");
		expect(factory).toHaveBeenCalledTimes(1);
		now += 1_001;
		await expect(tool.execute("expired", {})).rejects.toThrow("Last-known service state is not current");
		expect(factory).toHaveBeenCalledTimes(2);
		now += 60_001;
		const recovered = {
			request: vi.fn(async () => ({ op: "list", daemons: [] })),
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		factory.mockResolvedValue(recovered);
		await expect(tool.execute("recovered", {})).rejects.toThrow("Nothing to wait for");
		await expect(tool.execute("fresh-again", {})).rejects.toThrow("Nothing to wait for");
		expect(factory).toHaveBeenCalledTimes(4);
	});

	test("discovery failure reuse never hides a local deliverable or claims fresh services", async () => {
		const broker = {
			request: async () => {
				throw new daemonClient.DaemonBrokerUnavailableError("Daemon broker connection closed");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		const factory = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new WaitTool(session(manager, "Main", true));
		await expect(tool.execute("failed", {})).rejects.toThrow("Last-known service state is not current");
		const id = manager.register("bash", "local-after-failure", async () => "local deliverable", { ownerId: "Main" });
		await manager.waitForAll();
		try {
			const result = await tool.execute("local", {});
			expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "local deliverable" });
			expect(manager.isJobResultConsumed(id)).toBe(true);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(
				result.content.some(block => block.type === "text" && block.text.includes("Reused recent broker failure")),
			).toBe(true);
			expect(
				result.content.some(
					block => block.type === "text" && block.text.includes("Last-known service state is not current"),
				),
			).toBe(true);
		} finally {
			await manager.dispose();
		}
	});

	test("discovery failure reuse is scoped to cwd, session, and agent", async () => {
		const broker = {
			request: async () => {
				throw new daemonClient.DaemonBrokerUnavailableError("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		const factory = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		const current = session(undefined, "Main", true);
		let sessionId = "session-one";
		let agentId = "Main";
		current.getSessionId = () => sessionId;
		current.getAgentId = () => agentId;
		const tool = new WaitTool(current);
		await expect(tool.execute("first", {})).rejects.toThrow("Last-known service state is not current");
		await expect(tool.execute("same", {})).rejects.toThrow("Reused recent broker failure");
		expect(factory).toHaveBeenCalledTimes(1);
		current.cwd += "/other-project";
		await expect(tool.execute("cwd-changed", {})).rejects.toThrow("Last-known service state is not current");
		expect(factory).toHaveBeenCalledTimes(2);
		sessionId = "session-two";
		await expect(tool.execute("session-changed", {})).rejects.toThrow("Last-known service state is not current");
		expect(factory).toHaveBeenCalledTimes(3);
		agentId = "Other";
		await expect(tool.execute("agent-changed", {})).rejects.toThrow("Last-known service state is not current");
		expect(factory).toHaveBeenCalledTimes(4);
	});

	test("caller cancellation during discovery is not reusable as a broker failure", async () => {
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<never>();
		const broker = {
			request: async () => {
				entered.resolve();
				return response.promise;
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		const factory = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		const tool = new WaitTool(session(undefined, "Main", true));
		const controller = new AbortController();
		const waiting = tool.execute("cancelled", {}, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		response.reject(new Error("Daemon broker request aborted"));
		const recovered = {
			request: async () => ({ op: "list", daemons: [] }),
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		factory.mockResolvedValue(recovered);
		await expect(tool.execute("next", {})).rejects.toThrow("Nothing to wait for");
		expect(factory).toHaveBeenCalledTimes(2);
	});
	test("operation rejection and unclassified discovery errors are never reused as infrastructure failures", async () => {
		for (const failure of [
			new daemonClient.DaemonBrokerRejectedError("List rejected"),
			new Error("Unclassified discovery failure"),
		]) {
			const broker = {
				request: async () => {
					throw failure;
				},
				onCompletion: () => () => {},
			} as unknown as DaemonBrokerClient;
			const factory = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
			const tool = new WaitTool(session(undefined, "Main", true));
			await expect(tool.execute("first", {})).rejects.toThrow("Last-known service state is not current");
			await expect(tool.execute("second", {})).rejects.toThrow("Last-known service state is not current");
			expect(factory).toHaveBeenCalledTimes(2);
			factory.mockRestore();
		}
	});
});
