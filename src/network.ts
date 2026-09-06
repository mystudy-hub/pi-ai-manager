// ---------------------------------------------------------------------------
// Network helpers with retry, timeout, and rate limiting
// ---------------------------------------------------------------------------

import type { RelayApi, RelayProviderEntry, CompiledOverride } from "./types.ts";
import { inferReasoningSupport } from "./reasoning.ts";
import {
	DISCOVERY_TIMEOUT_MS,
	MAX_RETRIES,
	SUPPORTED_APIS,
	API_PREFERENCE,
	ENDPOINT_TYPE_TO_APIS,
	DEFAULT_TEST_REQUEST_DELAY_MS,
	RelayError,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Rate Limiter — Smart rate control with backoff
// ---------------------------------------------------------------------------

export class RateLimiter {
	private lastRequest = 0;
	private failureCount = 0;
	private readonly baseDelayMs: number;
	private pending: Promise<void> = Promise.resolve();

	constructor(baseDelayMs: number = DEFAULT_TEST_REQUEST_DELAY_MS) {
		this.baseDelayMs = baseDelayMs;
	}

	async acquire(): Promise<void> {
		const acquire = this.pending.then(async () => {
			const delay = this.calculateDelay();
			const waitMs = Math.max(0, this.lastRequest + delay - Date.now());
			if (waitMs > 0) await sleep(waitMs);
			this.lastRequest = Date.now();
		});
		this.pending = acquire.catch(() => undefined);
		return acquire;
	}

	private calculateDelay(): number {
		return Math.min(
			this.baseDelayMs * Math.pow(1.5, Math.min(this.failureCount, 5)),
			10000, // Cap at 10 seconds
		);
	}

	recordSuccess(): void {
		this.failureCount = Math.max(0, this.failureCount - 1);
	}

	recordFailure(): void {
		this.failureCount++;
	}

	reset(): void {
		this.failureCount = 0;
		this.lastRequest = 0;
	}
}

// ---------------------------------------------------------------------------
// Fetch with timeout & retry
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	if (init.signal) {
		if (init.signal.aborted) {
			controller.abort();
		} else {
			init.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let timerCleared = false;
	const clearTimer = () => {
		if (!timerCleared) {
			timerCleared = true;
			clearTimeout(timer);
		}
	};

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });

		const origJson = response.json.bind(response);
		const origText = response.text.bind(response);

		const wrapWithAbort = <T>(promise: Promise<T>): Promise<T> => {
			if (controller.signal.aborted) {
				clearTimer();
				throw new RelayError("timeout", `request to ${url} timed out after ${timeoutMs / 1000}s`);
			}
			const abortPromise = new Promise<never>((_, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => {
						clearTimer();
						reject(new RelayError("timeout", `request to ${url} timed out after ${timeoutMs / 1000}s`));
					},
					{ once: true },
				);
			});
			return Promise.race([promise, abortPromise]).finally(() => {
				clearTimer();
			});
		};

		response.json = () => wrapWithAbort(origJson());
		response.text = () => wrapWithAbort(origText());

		return response;
	} catch (error) {
		clearTimer();
		if (controller.signal.aborted)
			throw new RelayError("timeout", `request to ${url} timed out after ${timeoutMs / 1000}s`);
		throw new RelayError("network", `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Parse a Retry-After header. Returns undefined when absent or unparseable so
 * the caller falls back to exponential backoff — note that `Number(null)` is
 * `0`, so an absent header must be rejected before any numeric coercion.
 */
function parseRetryAfter(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	// delta-seconds
	if (/^\d+$/.test(trimmed)) {
		return Math.min(Number(trimmed) * 1000, 30_000);
	}

	// HTTP-date
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.min(Math.max(0, at - Date.now()), 30_000);
}

export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	maxRetries: number = MAX_RETRIES,
): Promise<Response> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, init, timeoutMs);
			if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt >= maxRetries) {
				return response;
			}
			const delayMs = parseRetryAfter(response.headers.get("retry-after")) ?? Math.min(1000 * Math.pow(2, attempt), 5000);
			await sleep(delayMs);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (error instanceof RelayError && error.code === "auth") throw error;
			if (attempt < maxRetries) await sleep(Math.min(1000 * Math.pow(2, attempt), 5000));
		}
	}

	throw lastError ?? new RelayError("network", `request to ${url} failed after ${maxRetries + 1} attempts`);
}

export { fetchWithTimeout, parseRetryAfter };

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
	id: string;
	types: string[];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingMode?: "auto" | "enabled" | "disabled";
	thinkingEffort?: "low" | "medium" | "high";
	hasImageInput?: boolean;
}

export async function fetchModelList(baseUrl: string, apiKey: string | undefined): Promise<DiscoveredModel[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetchWithRetry(url, { headers }, DISCOVERY_TIMEOUT_MS);

	if (response.status === 401 || response.status === 403) {
		throw new RelayError("auth", `GET /v1/models returned ${response.status} — run /login first`);
	}
	if (!response.ok) {
		throw new RelayError("http", `GET /v1/models returned ${response.status} ${response.statusText}`);
	}

	const json = (await response.json()) as { data?: unknown };
	if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
		throw new RelayError("payload", "/v1/models payload has no data array");
	}

	const output: DiscoveredModel[] = [];

	for (const item of json.data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || !record.id.trim()) continue;

		const types = Array.isArray(record.supported_endpoint_types)
			? record.supported_endpoint_types.filter((x): x is string => typeof x === "string")
			: [];

		const contextWindow =
			typeof record.max_context === "number" && record.max_context > 0
				? record.max_context
				: typeof record.context_window === "number" && record.context_window > 0
					? record.context_window
					: typeof record.contextWindow === "number" && record.contextWindow > 0
						? record.contextWindow
						: undefined;

		const maxTokens =
			typeof record.max_tokens === "number" && record.max_tokens > 0
				? record.max_tokens
				: typeof record.maxTokens === "number" && record.maxTokens > 0
					? record.maxTokens
					: undefined;

		const explicitReasoning =
			typeof record.reasoning === "boolean"
				? record.reasoning
				: typeof record.supports_reasoning === "boolean"
					? record.supports_reasoning
					: undefined;

		const reasoning = explicitReasoning ?? inferReasoningSupport(record.id);

		const thinkingMode =
			typeof record.thinking_mode === "string" && ["auto", "enabled", "disabled"].includes(record.thinking_mode)
				? (record.thinking_mode as "auto" | "enabled" | "disabled")
				: typeof record.thinkingMode === "string" && ["auto", "enabled", "disabled"].includes(record.thinkingMode)
					? (record.thinkingMode as "auto" | "enabled" | "disabled")
					: undefined;

		const thinkingEffort =
			typeof record.thinking_effort === "string" && ["low", "medium", "high"].includes(record.thinking_effort)
				? (record.thinking_effort as "low" | "medium" | "high")
				: typeof record.thinkingEffort === "string" && ["low", "medium", "high"].includes(record.thinkingEffort)
					? (record.thinkingEffort as "low" | "medium" | "high")
					: undefined;

		const hasImageInput = Array.isArray(record.input)
			? (record.input as unknown[]).includes("image")
			: Array.isArray(record.supported_input_modalities)
				? (record.supported_input_modalities as unknown[]).includes("image")
				: false;

		output.push({ id: record.id, types, contextWindow, maxTokens, reasoning, thinkingMode, thinkingEffort, hasImageInput });
	}

	return output;
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

export function compileOverrides(overrides: Record<string, RelayApi>): CompiledOverride[] {
	const rules: CompiledOverride[] = [];
	for (const [pattern, api] of Object.entries(overrides ?? {})) {
		if (!SUPPORTED_APIS.has(api)) continue;
		try {
			rules.push({ regex: new RegExp(pattern), api });
		} catch (error) {
			console.warn(`ai-gateway: invalid modelApiOverrides regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rules;
}

export function applyOverride(modelId: string, fallback: RelayApi, rules: CompiledOverride[]): RelayApi {
	return rules.find((rule) => rule.regex.test(modelId))?.api ?? fallback;
}

export function resolveApi(types: readonly string[], modelId: string, entry: RelayProviderEntry, rules: CompiledOverride[]): RelayApi {
	const matched = rules.find((rule) => rule.regex.test(modelId));
	if (matched) return matched.api;
	const gatewayApis = new Set<RelayApi>();
	for (const type of types) {
		for (const api of ENDPOINT_TYPE_TO_APIS[type] ?? []) gatewayApis.add(api);
	}
	if (gatewayApis.has(entry.defaultApi)) return entry.defaultApi;
	for (const api of API_PREFERENCE) {
		if (gatewayApis.has(api)) return api;
	}
	return entry.defaultApi;
}

export function resolveApiBaseUrl(baseUrl: string, api: RelayApi): string {
	const base = baseUrl.replace(/\/+$/, "");
	if (api === "openai-completions" || api === "openai-responses") {
		return `${base}/v1`;
	}
	return base;
}