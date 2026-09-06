// ---------------------------------------------------------------------------
// Model Testing with Metrics
// ---------------------------------------------------------------------------

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TestResult, PerformanceMetrics, RelayModelMeta } from "./types.ts";
import { TEST_TIMEOUT_MS, TEST_QUESTIONS_PER_MODEL } from "./types.ts";
import { RateLimiter } from "./network.ts";

// ---------------------------------------------------------------------------
// Result → health
// ---------------------------------------------------------------------------

/**
 * Fold a TestResult into a model's persisted health. Shared by the CLI command
 * and both TUI test paths so the mapping cannot drift between them.
 */
export function applyTestResultToMeta(meta: RelayModelMeta, result: TestResult): void {
	// Nothing was actually asked — an unregistered model or an empty question
	// list. Leaving health untouched keeps it "unknown" instead of inventing a
	// verdict (0/0 would otherwise read as a clean pass).
	if (result.skipped || result.total === 0) return;

	const now = Date.now();
	if (result.passed === result.total) {
		meta.health = { status: "healthy", lastCheck: now, consecutiveFailures: 0 };
	} else if (result.passed > 0) {
		meta.health = { status: "degraded", lastCheck: now, consecutiveFailures: 0 };
	} else {
		meta.health = { status: "down", lastCheck: now, consecutiveFailures: (meta.health?.consecutiveFailures ?? 0) + 1 };
	}
	if (result.metrics) meta.metrics = result.metrics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hasValidResponse(message: { content: unknown; stopReason?: string; errorMessage?: string }): {
	valid: boolean;
	textLength: number;
} {
	if (message.errorMessage) return { valid: false, textLength: 0 };
	if (message.stopReason && !["stop", "length", "toolUse"].includes(message.stopReason)) {
		return { valid: false, textLength: 0 };
	}
	if (!Array.isArray(message.content)) return { valid: false, textLength: 0 };

	let totalLength = 0;
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string };
		if (b.type === "text" && typeof b.text === "string") {
			totalLength += b.text.trim().length;
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			totalLength += b.thinking.trim().length;
		}
	}

	return { valid: totalLength > 0, textLength: totalLength };
}

export function pickQuestions(questions: readonly string[], index: number): string[] {
	if (questions.length <= TEST_QUESTIONS_PER_MODEL) return [...questions];
	const start = (index * TEST_QUESTIONS_PER_MODEL) % questions.length;
	const picked: string[] = [];
	for (let k = 0; k < TEST_QUESTIONS_PER_MODEL; k++) {
		picked.push(questions[(start + k) % questions.length]);
	}
	return picked;
}

function sanitizeReason(message: string): string {
	let clean = message
		.replace(/Bearer\s+[A-Za-z0-9._~/-]+/gi, "Bearer ***")
		.replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-***");
	if (/<!doctype html|<\s*html/i.test(clean)) {
		clean = "received HTML instead of JSON (firewall/proxy challenge blocking API)";
	}
	clean = clean.replace(/\s+/g, " ").trim();
	return clean.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Single prompt test
// ---------------------------------------------------------------------------

export async function runTestPrompt(
	ctx: ExtensionCommandContext,
	model: Model<Api>,
	question: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string; responseTime: number; tokens?: number }> {
	const startTime = Date.now();

	if (signal?.aborted) {
		return { ok: false, reason: "aborted", responseTime: 0 };
	}

	try {
		const result = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: "You are a helpful assistant. Answer briefly and directly.",
				messages: [{ role: "user", content: question, timestamp: Date.now() }],
			},
			{
				maxTokens: 256,
				maxRetries: 0,
				timeoutMs: TEST_TIMEOUT_MS,
				cacheRetention: "none",
				signal,
			},
		);

		const responseTime = Date.now() - startTime;
		const validation = hasValidResponse(result);

		if (validation.valid) {
			// pi-ai reports usage as {input, output, cacheRead, cacheWrite} — there
			// is no `total_tokens` field.
			const usage = result.usage;
			const tokens = usage ? usage.input + usage.output : undefined;
			return { ok: true, responseTime, tokens };
		}

		return {
			ok: false,
			reason: sanitizeReason(
				`stopReason=${result.stopReason}` + (result.errorMessage ? ` (${result.errorMessage})` : ""),
			),
			responseTime,
		};
	} catch (error) {
		const responseTime = Date.now() - startTime;
		return {
			ok: false,
			reason: sanitizeReason(error instanceof Error ? error.message : String(error)),
			responseTime,
		};
	}
}

// ---------------------------------------------------------------------------
// Single model test (multiple prompts)
// ---------------------------------------------------------------------------

export async function testModel(
	ctx: ExtensionCommandContext,
	providerName: string,
	modelId: string,
	questions: readonly string[],
	rateLimiter: RateLimiter,
	signal?: AbortSignal,
): Promise<TestResult> {
	if (signal?.aborted) {
		return { passed: 0, total: questions.length, reasons: ["aborted"], skipped: true };
	}

	const model = ctx.modelRegistry.find(providerName, modelId);
	if (!model) {
		// No request was sent. Flagged as skipped so callers leave health alone —
		// folding this into a 0/N failure would mark never-contacted models "down".
		console.warn(`ai-gateway: model "${providerName}/${modelId}" not found in registry; skipping.`);
		return { passed: 0, total: questions.length, reasons: ["model not registered"], skipped: true };
	}

	let passed = 0;
	const reasons: string[] = [];
	const responseTimes: number[] = [];
	let totalTokens = 0;
	let tokenCount = 0;

	for (let q = 0; q < questions.length; q++) {
		if (signal?.aborted) break;
		await rateLimiter.acquire();
		if (signal?.aborted) break;

		const outcome = await runTestPrompt(ctx, model, questions[q], signal);
		if (signal?.aborted) break;
		responseTimes.push(outcome.responseTime);

		if (outcome.ok) {
			passed++;
			rateLimiter.recordSuccess();
			if (outcome.tokens !== undefined) {
				totalTokens += outcome.tokens;
				tokenCount++;
			}
		} else {
			rateLimiter.recordFailure();
			if (outcome.reason) reasons.push(outcome.reason);
		}
	}

	if (responseTimes.length === 0) {
		return {
			passed,
			total: questions.length,
			reasons: reasons.length > 0 ? reasons : ["no test questions"],
			metrics: undefined,
		};
	}

	const metrics: PerformanceMetrics = {
		avgResponseTime: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
		minResponseTime: Math.min(...responseTimes),
		maxResponseTime: Math.max(...responseTimes),
		avgTokens: tokenCount > 0 ? Math.round(totalTokens / tokenCount) : undefined,
		timestamp: Date.now(),
	};

	return { passed, total: questions.length, reasons, metrics };
}

// ---------------------------------------------------------------------------
// Parallel testing with concurrency control
// ---------------------------------------------------------------------------

export async function testModelsInParallel(
	ctx: ExtensionCommandContext,
	providerName: string,
	modelIds: string[],
	questions: readonly string[],
	concurrency: number,
	rateLimiter: RateLimiter,
	onProgress?: (modelId: string, index: number, total: number) => void,
	signal?: AbortSignal,
): Promise<Map<string, TestResult>> {
	const results = new Map<string, TestResult>();
	const queue = modelIds.map((id, index) => ({ id, index }));
	let started = 0;

	async function worker(): Promise<void> {
		while (queue.length > 0) {
			if (signal?.aborted) break;
			const item = queue.shift();
			if (!item) break;

			// Count starts, not completions: with N workers in flight, reporting a
			// shared completion counter makes every worker announce the same index.
			started++;
			onProgress?.(item.id, started, modelIds.length);

			const result = await testModel(
				ctx,
				providerName,
				item.id,
				pickQuestions(questions, item.index),
				rateLimiter,
				signal,
			);

			if (signal?.aborted) break;
			results.set(item.id, result);
		}
	}

	const workerCount = Math.max(1, Math.min(Math.floor(concurrency), modelIds.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

// ---------------------------------------------------------------------------
// Context window probing
// ---------------------------------------------------------------------------

/**
 * Probe a model's actual context window by sending progressively larger prompts
 * until we hit a context length error. Uses binary search for efficiency.
 */
export async function probeContextWindow(
	ctx: ExtensionCommandContext,
	providerName: string,
	modelId: string,
	reportedWindow?: number,
	signal?: AbortSignal,
): Promise<number | undefined> {
	const model = ctx.modelRegistry.find(providerName, modelId);
	if (!model) {
		console.warn(`ai-gateway: model "${providerName}/${modelId}" not found in registry; skipping context probe.`);
		return undefined;
	}

	// Start with reported value or use common checkpoints
	const checkpoints = reportedWindow
		? [reportedWindow]
		: [4096, 8192, 16384, 32768, 65536, 128000, 200000, 500000, 1000000];

	let lastSuccessful: number | undefined = undefined;

	for (const size of checkpoints) {
		if (signal?.aborted) break;
		const testPrompt = generatePromptOfSize(size);
		const startTime = Date.now();

		try {
			const result = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [{ role: "user", content: testPrompt, timestamp: Date.now() }],
				},
				{
					maxTokens: 128,
					maxRetries: 0,
					timeoutMs: TEST_TIMEOUT_MS,
					cacheRetention: "none",
					signal,
				},
			);

			const elapsed = Date.now() - startTime;

			// Check if the response is valid
			const validation = hasValidResponse(result);
			if (validation.valid) {
				lastSuccessful = size;
				console.log(`ai-gateway: context probe ${modelId} @ ${size} tokens: OK (${elapsed}ms)`);
			} else {
				// Stop on first failure
				console.log(`ai-gateway: context probe ${modelId} @ ${size} tokens: invalid response`);
				break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			// Check if this is a context length error
			if (
				message.includes("context") ||
				message.includes("length") ||
				message.includes("token") ||
				message.includes("too long") ||
				message.includes("maximum")
			) {
				console.log(`ai-gateway: context probe ${modelId} @ ${size} tokens: context limit reached`);
				break;
			}

			// Other errors: stop probing
			console.warn(`ai-gateway: context probe ${modelId} @ ${size} tokens failed: ${sanitizeReason(message)}`);
			break;
		}
	}

	return lastSuccessful;
}

/**
 * Generate a test prompt of approximately the target token count.
 * Uses repeated text to reach the desired size efficiently.
 */
function generatePromptOfSize(targetTokens: number): string {
	// Rough estimate: 1 token ≈ 4 characters for English text
	const targetChars = targetTokens * 4;

	const chunk =
		"The quick brown fox jumps over the lazy dog. This is a test sentence used to fill context windows. ";
	const repeatCount = Math.ceil(targetChars / chunk.length);

	return chunk.repeat(repeatCount).slice(0, targetChars);
}