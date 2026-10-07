import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { extractUriScheme } from "../../internal-urls/parse";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import type { CascadeResult } from "./cascade";
import type { SearchRoot } from "./tree";

const FIND_TIMEOUT_MS = 20_000;
/** Local policy: reads and overlapping failures never extend the recovery interval. */
const FAILURE_TTL_MS = 30_000;

interface FindFailure {
	kind: "timeout" | "infrastructure";
	message: string;
	observedAt: number;
	/** Monotonic deadline; the wall clock is used only in the diagnostic. */
	expiresAt: number;
	scope: string;
}
interface ActiveScope {
	users: number;
	recovery: number;
}
interface RootHealth {
	failures: LRUCache<string, FindFailure>;
	active: Map<string, ActiveScope>;
}

// Task siblings share their inherited root bus; unrelated and disposed roots stay isolated.
// These observations never enter the judgment answer cache.
const roots = new WeakMap<object, RootHealth>();

function scopeKey(root: SearchRoot): string {
	const scheme = extractUriScheme(root.path);
	let scope: string;
	if (scheme) {
		scope = `${scheme}${root.path.slice(root.path.indexOf(":"))}`;
		if (root.type === "directory" && scope.includes("://")) {
			const prefixLength = scheme.length + 3;
			scope = scope.slice(0, prefixLength) + scope.slice(prefixLength).replace(/\/+$/, "");
		}
	} else {
		scope = path.resolve(root.path);
		if (process.platform === "win32") scope = scope.toLowerCase();
	}
	return `${root.type}:${scope}`;
}

/** Only explicit service/transport failures qualify, never arbitrary error text. */
function infrastructureFailure(error: unknown, depth = 0): Pick<FindFailure, "kind" | "message"> | undefined {
	if (!(error instanceof Error) || depth > 8) return undefined;
	if (error.name === "AbortError" || error.name === "ToolAbortError") return undefined;
	// Inspect aggregates before their own metadata: every cause must qualify.
	if (error instanceof AggregateError) {
		const errors: readonly unknown[] = error.errors;
		if (errors.length === 0) return undefined;
		let first: Pick<FindFailure, "kind" | "message"> | undefined;
		for (const cause of errors) {
			const failure = infrastructureFailure(cause, depth + 1);
			if (!failure) return undefined;
			first ??= failure;
		}
		return first;
	}
	const fields = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
	const status = typeof fields.status === "number" ? fields.status : fields.statusCode;
	if (status !== undefined) {
		return status === 502 || status === 503 || status === 504
			? { kind: "infrastructure", message: `HTTP ${status}` }
			: undefined;
	}
	if (error.name === "TimeoutError") return { kind: "timeout", message: "TimeoutError" };
	if (fields.code === "ETIMEDOUT") return { kind: "timeout", message: "transport ETIMEDOUT" };
	if (
		fields.code === "ECONNRESET" ||
		fields.code === "ECONNREFUSED" ||
		fields.code === "ConnectionRefused" ||
		fields.code === "EAI_AGAIN" ||
		fields.code === "ENOTFOUND" ||
		fields.code === "EPIPE"
	)
		return { kind: "infrastructure", message: `transport ${fields.code}` };
	return infrastructureFailure(error.cause, depth + 1);
}

function describeFailure(failure: FindFailure, reused: boolean): string {
	const reuse = reused ? "; reused recent failure; this call did not execute semantic search" : "";
	return `find ${failure.kind} failure in ${failure.scope}, observed ${new Date(failure.observedAt).toISOString()}: ${failure.message}${reuse}`;
}

export interface FindSearchOptions {
	/** Inherited task-root event bus, or the session when no root bus exists. */
	owner: object;
	root: SearchRoot;
	signal?: AbortSignal;
	/** Smaller isolated-test budget exercises the actual cancellation boundary. */
	timeoutMs?: number;
	search: (signal: AbortSignal, onJudgeError: (error: unknown) => void) => Promise<CascadeResult>;
}

/** Reuse observations only; concurrent searches keep independent signals and results. */
export async function runFindSearch(options: FindSearchOptions): Promise<CascadeResult> {
	throwIfAborted(options.signal);
	let health = roots.get(options.owner);
	if (!health) {
		health = { failures: new LRUCache({ max: 256 }), active: new Map() };
		roots.set(options.owner, health);
	}
	const rootHealth = health;
	const key = scopeKey(options.root);
	const recent = health.failures.get(key);
	if (recent && performance.now() < recent.expiresAt) throw new ToolError(describeFailure(recent, true));
	if (recent) health.failures.delete(key);
	let active = health.active.get(key);
	if (!active) {
		active = { users: 0, recovery: 0 };
		health.active.set(key, active);
	}
	const scopeState = active;
	scopeState.users++;
	const recovery = scopeState.recovery;
	const record = (kind: FindFailure["kind"], message: string, reusable = true): FindFailure => {
		const now = performance.now();
		const failure: FindFailure = {
			kind,
			message,
			observedAt: Date.now(),
			scope: options.root.path,
			expiresAt: now + FAILURE_TTL_MS,
		};
		// A success after this attempt began is newer recovery evidence. Overlapping
		// failures retain the first observation, including its original deadline.
		const previous = rootHealth.failures.get(key);
		if (reusable && scopeState.recovery === recovery && (!previous || now >= previous.expiresAt)) {
			rootHealth.failures.set(key, failure);
		}
		return failure;
	};
	const timeoutMs = options.timeoutMs ?? FIND_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let judgeErrors = 0;
	let transientErrors = 0;
	let judgeFailure: Pick<FindFailure, "kind" | "message"> | undefined;
	try {
		const result = await options.search(signal, error => {
			judgeErrors++;
			const failure = infrastructureFailure(error);
			if (failure) {
				transientErrors++;
				judgeFailure ??= failure;
			}
		});
		throwIfAborted(signal);
		if (
			judgeFailure &&
			transientErrors === result.stats.requests &&
			judgeErrors === result.stats.requests &&
			result.stats.errors === result.stats.requests
		) {
			record(judgeFailure.kind, judgeFailure.message);
		} else if (judgeErrors < result.stats.requests || result.stats.requests === 0) {
			scopeState.recovery++;
			rootHealth.failures.delete(key);
		}
		return result;
	} catch (error) {
		// Caller cancellation wins even when the wall-clock deadline also elapsed.
		throwIfAborted(options.signal);
		const failure = infrastructureFailure(error);
		if (timeout.aborted) {
			// A deadline cannot erase earlier permanent/mixed judge failures.
			const reusable = judgeErrors === transientErrors && (failure !== undefined || error instanceof ToolAbortError);
			throw new ToolError(
				describeFailure(record("timeout", `timed out after ${formatDuration(timeoutMs)}`, reusable), false),
			);
		}
		if (failure && judgeErrors === transientErrors) record(failure.kind, failure.message);
		throw error;
	} finally {
		if (--scopeState.users === 0) rootHealth.active.delete(key);
	}
}
