// ---------------------------------------------------------------------------
// Types for ai-gateway extension
// ---------------------------------------------------------------------------

export type RelayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface PerformanceMetrics {
	avgResponseTime: number;
	minResponseTime: number;
	maxResponseTime: number;
	/** Mean tokens (input + output) per request across the run, not a sum. */
	avgTokens?: number;
	timestamp: number;
}

export interface HealthStatus {
	status: "unknown" | "healthy" | "degraded" | "down";
	lastCheck?: number;
	consecutiveFailures: number;
}

export interface RelayModelMeta {
	api: RelayApi;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	input?: ("text" | "image")[];
	health?: HealthStatus;
	metrics?: PerformanceMetrics;
	lastDiscovered?: number;
}

export interface RelayProviderEntry {
	baseUrl: string;
	/**
	 * API key stored by the extension itself. pi has no extension-facing way to
	 * write auth.json, so a key entered in the TUI is persisted here (file mode
	 * 0600) and passed to registerProvider as a runtime literal. When absent,
	 * pi falls back to the /login credential.
	 */
	apiKey?: string;
	defaultApi: RelayApi;
	modelApiOverrides?: Record<string, RelayApi>;
	models: Record<string, RelayModelMeta>;
	enabledModels: string[];
}

export interface RelaySettings {
	testQuestions?: string[];
	testRequestDelayMs?: number;
	testConcurrency?: number;
}

export interface RelayConfig {
	version: 1;
	providers: Record<string, RelayProviderEntry>;
	settings: RelaySettings;
}

export interface TestResult {
	passed: number;
	total: number;
	reasons: string[];
	metrics?: PerformanceMetrics;
	/**
	 * True when no request was ever sent (e.g. the model is not registered with
	 * the provider). Callers must not fold this into health — a model that was
	 * never reached is "unknown", not "down".
	 */
	skipped?: boolean;
}

export interface CompiledOverride {
	regex: RegExp;
	api: RelayApi;
}

export interface DuplicateModelInstance {
	gateway: string;
	modelId: string;
	metrics?: PerformanceMetrics;
	health?: HealthStatus;
}

export interface DuplicateModelGroup {
	modelId: string;
	instances: DuplicateModelInstance[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_FILENAME = "provider-ai.json";

export const SUPPORTED_APIS = new Set<RelayApi>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
]);

export const API_PREFERENCE: readonly RelayApi[] = [
	"anthropic-messages",
	"openai-responses",
	"openai-completions",
];

export const ENDPOINT_TYPE_TO_APIS: Record<string, readonly RelayApi[]> = {
	anthropic: ["anthropic-messages"],
	openai: ["openai-completions", "openai-responses"],
};

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_TOKENS = 32_768;
export const DISCOVERY_TIMEOUT_MS = 15_000;
export const REACHABILITY_TIMEOUT_MS = 5_000;
export const TEST_TIMEOUT_MS = 30_000;

/** Increased from 2 to 3 to reduce false negatives from transient network jitter. */
export const TEST_QUESTIONS_PER_MODEL = 3;

export const DEFAULT_TEST_CONCURRENCY = 3;
export const DEFAULT_TEST_REQUEST_DELAY_MS = 500;
export const MAX_RETRIES = 2;

export const DEFAULT_TEST_QUESTIONS: readonly string[] = [
	"你好，请用一句话介绍一下你自己。",
	"Hi, introduce yourself in one sentence.",
	"今天北京的天气怎么样？",
	"What is 1+1? Answer in one word.",
	"你是什么模型？能帮我做什么？",
	"请把 \"hello world\" 翻译成中文。",
	"请列出三种编程语言。",
	"Name three programming languages.",
	"请写一句鼓励的话。",
	"请用通俗的话解释一下什么是 API。",
];

export class RelayError extends Error {
	readonly code: "timeout" | "network" | "auth" | "http" | "payload";

	constructor(code: RelayError["code"], message: string) {
		super(message);
		this.name = "RelayError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// TUI-specific types
// ---------------------------------------------------------------------------

export type SortMode = "name" | "status" | "performance" | "enabled";
export type FilterMode = "all" | "enabled" | "healthy" | "untested";
export type QualityFilter = "all" | "recommended" | "strict";