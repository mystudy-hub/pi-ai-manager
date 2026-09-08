// ---------------------------------------------------------------------------
// Network helpers with retry, timeout, and rate limiting
// ---------------------------------------------------------------------------

import type { RelayApi, RelayProviderEntry, CompiledOverride } from "./types.ts";
import { canonicalBaseUrl, isSafeIdentifier, isTokenLimit, MAX_DISCOVERED_MODELS, MAX_RESPONSE_BYTES, safeError } from "./security.ts";
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
		this.baseDelayMs = Number.isFinite(baseDelayMs) ? Math.max(0, Math.min(10_000, baseDelayMs)) : DEFAULT_TEST_REQUEST_DELAY_MS;
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		const acquire = this.pending.then(async () => {
			signal?.throwIfAborted();
			const delay = this.calculateDelay();
			const waitMs = Math.max(0, this.lastRequest + delay - Date.now());
			if (waitMs > 0) await sleep(waitMs, signal);
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason); return; }
		const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, ms);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Buffer a bounded body under the same deadline as the connection itself. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const abort = () => controller.abort(init.signal?.reason);
	if (init.signal?.aborted) abort();
	else init.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		controller.signal.throwIfAborted();
		const response = await abortable(fetch(url, { ...init, redirect: "error", signal: controller.signal }), controller.signal);
		const declaredSize = Number(response.headers.get("content-length"));
		if (declaredSize > MAX_RESPONSE_BYTES) {
			void response.body?.cancel().catch(() => {});
			throw new RelayError("payload", "Model discovery response exceeds 5 MiB");
		}
		if (!response.ok || !response.body) {
			void response.body?.cancel().catch(() => {});
			return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
		}
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const chunk = await abortable(reader.read(), controller.signal);
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new RelayError("payload", "Model discovery response exceeds 5 MiB");
			chunks.push(chunk.value);
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	} catch (error) {
		if (init.signal?.aborted) throw init.signal.reason;
		if (controller.signal.aborted) throw new RelayError("timeout", `Request timed out after ${timeoutMs / 1000}s`);
		if (error instanceof RelayError) throw error;
		throw new RelayError("network", `Discovery request failed: ${safeError(error)}`);
	} finally {
		clearTimeout(timer);
		init.signal?.removeEventListener("abort", abort);
		if (reader) { void reader.cancel().catch(() => {}); }
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
		init.signal?.throwIfAborted();
		try {
			const response = await fetchWithTimeout(url, init, timeoutMs);
			if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt >= maxRetries) {
				return response;
			}
			const delayMs = parseRetryAfter(response.headers.get("retry-after")) ?? Math.min(1000 * Math.pow(2, attempt), 5000);
			await sleep(delayMs, init.signal ?? undefined);
		} catch (error) {
			init.signal?.throwIfAborted();
			lastError = error instanceof Error ? error : new Error(String(error));
			if (error instanceof RelayError && ["auth", "payload"].includes(error.code)) throw error;
			if (attempt < maxRetries) await sleep(Math.min(1000 * Math.pow(2, attempt), 5000), init.signal ?? undefined);
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

export async function fetchModelList(
	baseUrl: string,
	apiKey: string | undefined,
	options: { signal?: AbortSignal; allowInsecureHttp?: boolean } = {},
): Promise<DiscoveredModel[]> {
	const base = canonicalBaseUrl(baseUrl, options.allowInsecureHttp);
	if (!base) throw new RelayError("network", "Use HTTPS for remote gateways; HTTP is allowed for loopback or an explicit allowInsecureHttp setting.");
	const url = `${base}/v1/models`;
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetchWithRetry(url, { headers, signal: options.signal }, DISCOVERY_TIMEOUT_MS);

	if (response.status === 401 || response.status === 403) {
		throw new RelayError("auth", `GET /v1/models returned ${response.status} — check the configured key or /login credential`);
	}
	if (!response.ok) {
		throw new RelayError("http", `GET /v1/models returned ${response.status} ${response.statusText}`);
	}

	let json: { data?: unknown };
	try { json = await response.json() as { data?: unknown }; }
	catch { throw new RelayError("payload", "/v1/models returned invalid JSON"); }
	if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
		throw new RelayError("payload", "/v1/models payload has no data array");
	}

	if (json.data.length > MAX_DISCOVERED_MODELS) throw new RelayError("payload", "Gateway returned more than 10,000 models");
	const seen = new Set<string>();
	const output: DiscoveredModel[] = [];

	for (const item of json.data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (!isSafeIdentifier(record.id) || seen.has(record.id)) continue;
		seen.add(record.id);

		const types = Array.isArray(record.supported_endpoint_types)
			? record.supported_endpoint_types.filter((x): x is string => typeof x === "string")
			: [];

		const contextWindow =
			isTokenLimit(record.max_context)
				? record.max_context
				: isTokenLimit(record.context_window)
					? record.context_window
					: isTokenLimit(record.contextWindow)
						? record.contextWindow
						: undefined;

		const maxTokens =
			isTokenLimit(record.max_tokens)
				? record.max_tokens
				: isTokenLimit(record.maxTokens)
					? record.maxTokens
					: undefined;

		const explicitReasoning =
			typeof record.reasoning === "boolean"
				? record.reasoning
				: typeof record.supports_reasoning === "boolean"
					? record.supports_reasoning
					: undefined;

		const reasoning = explicitReasoning;

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
		// Exact pins and simple prefix/suffix rules need no groups or nested repetition.
		// Multiple optional atoms and repeated alternations can backtrack exponentially too.
		const plain = pattern.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
		if (pattern.length > 1024 || /\\[1-9]/.test(pattern) || /[(){}]/.test(plain) ||
			(plain.match(/[*+?]/g)?.length ?? 0) > 1) continue;
		try {
			rules.push({ regex: new RegExp(pattern), api });
		} catch (error) {
			console.warn(`ai-gateway: invalid modelApiOverrides regex: ${safeError(error)}`);
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
		for (const api of Object.hasOwn(ENDPOINT_TYPE_TO_APIS, type) ? ENDPOINT_TYPE_TO_APIS[type] : []) gatewayApis.add(api);
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
