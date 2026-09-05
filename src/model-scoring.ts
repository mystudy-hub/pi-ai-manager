// ---------------------------------------------------------------------------
// Smart Model Filtering & Scoring
// ---------------------------------------------------------------------------

/**
 * Strip a `vendor/` prefix and a `:tier` suffix before pattern matching.
 *
 * Gateways are inconsistent about both — the same model shows up as
 * `gpt-oss-120b`, `openai/gpt-oss-120b` and `openai/gpt-oss-120b:free`.
 * Matching the raw id made anchored patterns silently vendor-specific.
 */
function baseModelId(modelId: string): string {
	return modelId.replace(/^[^/]+\//, "").replace(/:[a-z0-9-]+$/i, "");
}

// Known high-quality model families, matched against the stripped id.
const KNOWN_GOOD_PATTERNS: readonly RegExp[] = [
	/^claude-(opus|sonnet|haiku|fable)-[\d.]+/i,
	/^gpt-[45][\d.]*/i,
	/^gpt-oss-\d+b/i,
	/^o[34]-/i,
	/^grok-[\d.]+/i,
	/^deepseek-v\d+(-(pro|flash))?/i,
	/^deepseek-r\d+/i,
	/^glm-[\d.]+/i,
	/^qwen[\d.]*/i,
	/^gemini-[\d.]+/i,
	/^kimi-/i,
	/^codex-/i,
	/^muse-/i,
	/^mimo-/i,
	/^ox-/i,
	/^ling-/i,
	/^longcat-/i,
	/^north-/i,
	/^nemotron-[\d.]+-(ultra|super)/i,
	/^llama-3\.[13]-\d+b-(versatile|instruct)/i,
];

// Genuinely low-value models: safety classifiers, tiny models, non-chat heads.
// Note `:free` is deliberately absent — it is a price tier, not a quality
// signal, and excluding it dropped flagship models like nemotron-ultra-550b.
const GARBAGE_PATTERNS: readonly RegExp[] = [
	/guard/i,
	/content-safety/i,
	/^llama-prompt/i,
	/\b[1-9]b\b/i,
	/\b1[0-9]b\b/i,
	/nemotron-.*-nano/i,
	/^laguna-(xs|s)-/i,
	/^north-mini/i,
	// Non-chat endpoints. These answer a text prompt with an error, so leaving
	// them in would auto-enable models that then test as "down".
	/-(audio|realtime|tts|transcribe|embed|embedding|rerank|moderation)(-|$)/i,
	/^(dall-e|whisper|text-embedding|gpt-image)/i,
];

export interface ModelQualityScore {
	isKnownGood: boolean;
	isGarbage: boolean;
	hasReasonableSize: boolean;
	recommendScore: number; // 0-100
	reasons: string[];
}

export function scoreModel(modelId: string): ModelQualityScore {
	const id = baseModelId(modelId);
	const reasons: string[] = [];
	let score = 50; // Base score

	const isKnownGood = KNOWN_GOOD_PATTERNS.some(pattern => pattern.test(id));
	if (isKnownGood) {
		score += 30;
		reasons.push("known-quality");
	}

	const isGarbage = GARBAGE_PATTERNS.some(pattern => pattern.test(id));
	if (isGarbage) {
		score -= 40;
		reasons.push("low-quality");
	}

	// Check size indicators. Mixture-of-experts ids carry both a total and an
	// active count ("120b-a12b"); the first number is the one that matters.
	const sizeMatch = id.match(/\b(\d+)b\b/i);
	const hasReasonableSize = !sizeMatch || Number.parseInt(sizeMatch[1], 10) >= 20;
	if (!hasReasonableSize) {
		score -= 20;
		reasons.push("too-small");
	}

	// Bonus for current flagship families
	if (/^(gpt-5[\d.]*|claude-(opus|sonnet|fable)-5|grok-[\d.]+|deepseek-v\d+|glm-[5-9])/i.test(id)) {
		score += 20;
		reasons.push("popular");
	}

	return {
		isKnownGood,
		isGarbage,
		hasReasonableSize,
		recommendScore: Math.max(0, Math.min(100, score)),
		reasons,
	};
}

/**
 * Filter and optionally sort models by quality.
 * @returns Always a new array (no shared reference with input).
 */
export function filterModels(models: string[], filterMode: "all" | "recommended" | "strict"): string[] {
	const copy = [...models];
	if (filterMode === "all") return copy;

	const scored = copy.map(id => ({ id, score: scoreModel(id) }));

	if (filterMode === "strict") {
		return scored
			.filter(m => m.score.isKnownGood && !m.score.isGarbage)
			.map(m => m.id);
	}

	// recommended: exclude garbage, prefer known good
	return scored
		.filter(m => !m.score.isGarbage && m.score.recommendScore >= 40)
		.sort((a, b) => b.score.recommendScore - a.score.recommendScore)
		.map(m => m.id);
}