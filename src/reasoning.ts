// ---------------------------------------------------------------------------
// Model reasoning / thinking detection and configuration heuristics
// ---------------------------------------------------------------------------

import type { RelayApi } from "./types.ts";

/**
 * Standard thinking level map type matching Pi's Model['thinkingLevelMap'].
 */
export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

/**
 * Non-reasoning models that match broader prefix patterns but do NOT support extended thinking.
 */
const REASONING_EXCLUSION_PATTERNS = [
	/gpt-5(?:-turbo)?-chat-latest/i,
	/gpt-5\.3-chat-latest/i,
	/deepseek-chat$/i,
	/deepseek-v3$/i,
	/deepseek-coder/i,
];

/**
 * Known model families and patterns that support reasoning / extended thinking.
 */
const REASONING_INCLUSION_PATTERNS = [
	// DeepSeek reasoning models (R1, V4 series)
	/deepseek-(?:r1|reasoner)/i,
	/deepseek-v4/i,

	// OpenAI reasoning models (o1, o3, o4 series, GPT-5 series)
	/(?:^|[-_/])o[134](?:-mini|-preview|-pro)?(?:[-_/]|$)/i,
	/(?:^|[-_/])gpt-5(?:\.[0-9]+)?(?:-[a-z0-9]+)*(?:[-_/]|$)/i,
	/codex-auto-review/i,

	// Qwen reasoning models (QwQ, Qwen 3.8 series)
	/(?:^|[-_/])qwq(?:-[a-z0-9]+)*(?:[-_/]|$)/i,
	/(?:^|[-_/])qwen3\.8(?:-[a-z0-9]+)*(?:[-_/]|$)/i,

	// Gemini reasoning models (thinking variants, 3.7+ flash/pro)
	/gemini-.*(?:thinking|flash-high|pro-low)/i,
	/gemini-3\.[5678]-flash/i,
	/gemini-3\.[0-9]+-pro/i,

	// Claude hybrid reasoning (3.7 Sonnet, Claude 4 series)
	/claude-3-7-sonnet/i,
	/claude-(?:sonnet|opus|haiku|fable)-[45]/i,

	// Kimi reasoning models
	/kimi-k(?:2\.7-code|3)/i,

	// Grok reasoning models
	/grok-4\.[56]/i,

	// Generic keywords / suffixes
	/(?:^|[-_./:])(?:r1|reason(?:er|ing)?|think(?:ing)?)(?:[-_./:]|$)/i,
];

/**
 * Determine if a model supports extended thinking / reasoning based on its ID.
 */
export function inferReasoningSupport(modelId: string): boolean {
	if (!modelId || typeof modelId !== "string") return false;

	const trimmed = modelId.trim();

	// Check exclusion patterns first
	for (const pattern of REASONING_EXCLUSION_PATTERNS) {
		if (pattern.test(trimmed)) return false;
	}

	// Check inclusion patterns
	for (const pattern of REASONING_INCLUSION_PATTERNS) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}

/**
 * Infer thinking level map for known reasoning models.
 * Maps Pi's thinking levels to provider/model values; null marks a level unsupported.
 */
export function inferThinkingLevelMap(modelId: string): ThinkingLevelMap | undefined {
	if (!modelId) return undefined;

	const id = modelId.toLowerCase();

	// DeepSeek R1 / V4: supports low, high, max (high & low are primary)
	if (id.includes("deepseek")) {
		return {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			max: "max",
		};
	}

	// OpenAI GPT-5 series (e.g. gpt-5.6-luna, gpt-5.4)
	if (id.includes("gpt-5")) {
		return {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};
	}

	// OpenAI o1 / o3 / o4 series
	if (/(?:^|[-_/])o[134](?:[-_/]|$)/.test(id)) {
		return {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		};
	}

	// Qwen 3.8 / QwQ series
	if (id.includes("qwen") || id.includes("qwq")) {
		return {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
		};
	}

	// Gemini reasoning
	if (id.includes("gemini")) {
		return {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
		};
	}

	// Default: undefined lets Pi use its standard levels ["off", "minimal", "low", "medium", "high"]
	return undefined;
}

/**
 * Infer API compatibility options for a reasoning model.
 * Different gateways and APIs require specific formats for thinking parameters.
 */
export function inferModelCompat(modelId: string, api: RelayApi): Record<string, unknown> | undefined {
	if (!modelId) return undefined;

	const id = modelId.toLowerCase();

	if (api === "openai-completions") {
		// DeepSeek via OpenAI completions requires "thinkingFormat: deepseek"
		if (id.includes("deepseek")) {
			return {
				thinkingFormat: "deepseek",
				maxTokensField: "max_tokens",
				requiresReasoningContentOnAssistantMessages: true,
				supportsDeveloperRole: false,
				supportsStore: false,
				supportsReasoningEffort: true,
			};
		}

		// Qwen via OpenAI completions requires "thinkingFormat: qwen"
		if (id.includes("qwen") || id.includes("qwq")) {
			return {
				thinkingFormat: "qwen",
				supportsReasoningEffort: true,
				supportsDeveloperRole: false,
				supportsStore: false,
			};
		}

		// OpenAI o-series or GPT-5 via completions
		if (/(?:^|[-_/])(?:o[134]|gpt-5)/.test(id)) {
			return {
				supportsReasoningEffort: true,
				maxTokensField: "max_completion_tokens",
			};
		}

		// Generic reasoning on openai-completions: allow reasoning_effort
		return {
			supportsReasoningEffort: true,
		};
	}

	if (api === "openai-responses") {
		// OpenAI responses API standard grammar and strict mode
		return {
			supportsOpenAIGrammarTools: true,
			supportsStrictMode: true,
		};
	}

	return undefined;
}
