// ---------------------------------------------------------------------------
// Configuration Management — read, normalize, write (atomic), scoped-models
// ---------------------------------------------------------------------------

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HealthStatus, PerformanceMetrics, RelayApi, RelayConfig, RelayModelMeta, RelayProviderEntry, RelaySettings } from "./types.ts";
import { CONFIG_FILENAME, SUPPORTED_APIS } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isRelayApi(value: unknown): value is RelayApi {
	return typeof value === "string" && SUPPORTED_APIS.has(value as RelayApi);
}

export function canonicalBaseUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		if (url.username || url.password || url.search || url.hash) return "";
		return url.toString().replace(/\/+$/, "").replace(/\/v1$/i, "");
	} catch {
		return "";
	}
}

export function formatTimeSince(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return `${seconds}s ago`;
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function normalizeHealthStatus(raw: unknown): HealthStatus | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const h = raw as Record<string, unknown>;
	return {
		status: ["unknown", "healthy", "degraded", "down"].includes(h.status as string)
			? (h.status as HealthStatus["status"])
			: "unknown",
		lastCheck: typeof h.lastCheck === "number" ? h.lastCheck : undefined,
		consecutiveFailures: typeof h.consecutiveFailures === "number" ? h.consecutiveFailures : 0,
	};
}

function normalizeMetrics(raw: unknown): PerformanceMetrics | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const m = raw as Record<string, unknown>;
	if (typeof m.avgResponseTime !== "number") return undefined;
	// `totalTokens` is the pre-v2.5 name for what was always a per-request mean.
	const tokens = typeof m.avgTokens === "number" ? m.avgTokens : typeof m.totalTokens === "number" ? m.totalTokens : undefined;
	return {
		avgResponseTime: m.avgResponseTime,
		minResponseTime: typeof m.minResponseTime === "number" ? m.minResponseTime : m.avgResponseTime,
		maxResponseTime: typeof m.maxResponseTime === "number" ? m.maxResponseTime : m.avgResponseTime,
		avgTokens: tokens,
		timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
	};
}

/** Exported for tests: the read path is where dropped fields go unnoticed. */
export function normalizeConfig(raw: unknown): RelayConfig {
	const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const providers: Record<string, RelayProviderEntry> = {};
	const rawProviders = (root.providers && typeof root.providers === "object" ? root.providers : {}) as Record<string, unknown>;

	for (const [name, value] of Object.entries(rawProviders)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		const baseUrl = typeof entry.baseUrl === "string" ? canonicalBaseUrl(entry.baseUrl) : "";
		if (!baseUrl) continue;

		const defaultApi: RelayApi = isRelayApi(entry.defaultApi) ? entry.defaultApi : "anthropic-messages";

		const modelApiOverrides: Record<string, RelayApi> = {};
		if (entry.modelApiOverrides && typeof entry.modelApiOverrides === "object") {
			for (const [pattern, api] of Object.entries(entry.modelApiOverrides as Record<string, unknown>)) {
				if (isRelayApi(api)) modelApiOverrides[pattern] = api;
			}
		}

		const models: Record<string, RelayModelMeta> = {};
		if (entry.models && typeof entry.models === "object") {
			for (const [id, meta] of Object.entries(entry.models as Record<string, unknown>)) {
				if (!meta || typeof meta !== "object") continue;
				const m = meta as Record<string, unknown>;
				if (!isRelayApi(m.api)) continue;
				const input = Array.isArray(m.input)
					? (m.input.filter((x): x is "text" | "image" => x === "text" || x === "image") as ("text" | "image")[])
					: undefined;
				const thinkingLevelMap =
					m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
						? (m.thinkingLevelMap as Record<string, string | null>)
						: undefined;
				const thinkingMode =
					typeof m.thinkingMode === "string" && ["auto", "enabled", "disabled"].includes(m.thinkingMode)
						? (m.thinkingMode as "auto" | "enabled" | "disabled")
						: undefined;
				const thinkingEffort =
					typeof m.thinkingEffort === "string" && ["low", "medium", "high"].includes(m.thinkingEffort)
						? (m.thinkingEffort as "low" | "medium" | "high")
						: undefined;
				const compat =
					m.compat && typeof m.compat === "object"
						? (m.compat as Record<string, unknown>)
						: undefined;

				models[id] = {
					api: m.api,
					...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					...(thinkingMode ? { thinkingMode } : {}),
					...(thinkingEffort ? { thinkingEffort } : {}),
					...(compat ? { compat } : {}),
					...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
					...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
					...(input && input.length > 0 ? { input } : {}),
					health: normalizeHealthStatus(m.health),
					metrics: normalizeMetrics(m.metrics),
					...(typeof m.lastDiscovered === "number" ? { lastDiscovered: m.lastDiscovered } : {}),
				};
			}
		}

		const enabledModels = (Array.isArray(entry.enabledModels) ? entry.enabledModels : [])
			.filter((x): x is string => typeof x === "string")
			.filter((id) => id in models);

		providers[name] = {
			baseUrl,
			...(typeof entry.apiKey === "string" && entry.apiKey ? { apiKey: entry.apiKey } : {}),
			defaultApi,
			modelApiOverrides,
			models,
			enabledModels: [...new Set(enabledModels)],
		};
	}

	const settings: RelaySettings = {};
	const rawSettings = (root.settings && typeof root.settings === "object" ? root.settings : {}) as Record<string, unknown>;
	if (Array.isArray(rawSettings.testQuestions)) {
		settings.testQuestions = rawSettings.testQuestions.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
	}
	const requestDelay = typeof rawSettings.testRequestDelayMs === "number" ? Math.round(rawSettings.testRequestDelayMs) : NaN;
	if (Number.isFinite(requestDelay) && requestDelay >= 0) settings.testRequestDelayMs = requestDelay;
	const concurrency = typeof rawSettings.testConcurrency === "number" ? Math.round(rawSettings.testConcurrency) : NaN;
	if (Number.isFinite(concurrency) && concurrency > 0) settings.testConcurrency = concurrency;

	return { version: 1, providers, settings };
}

// ---------------------------------------------------------------------------
// Read / Write (atomic)
// ---------------------------------------------------------------------------

export function configPath(): string {
	return join(getAgentDir(), "extension-settings", CONFIG_FILENAME);
}

export function emptyConfig(): RelayConfig {
	return { version: 1, providers: {}, settings: {} };
}

export function readConfig(): RelayConfig {
	const path = configPath();
	if (!existsSync(path)) return emptyConfig();
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch (error) {
		console.warn(`ai-gateway: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		try {
			const { getConfigRecoveryInstance } = require("./config-v2.ts");
			const recovery = getConfigRecoveryInstance();
			const backup = recovery.tryRecover(path);
			if (backup) {
				console.log(`ai-gateway: recovered config from backup: ${backup.path}`);
				return normalizeConfig(JSON.parse(backup.content) as unknown);
			}
		} catch (recError) {
			console.warn(`ai-gateway: auto-recovery failed: ${recError instanceof Error ? recError.message : String(recError)}`);
		}
		return emptyConfig();
	}
}

/**
 * Write JSON atomically: temp file → fsync → rename → fsync parent dir.
 * The parent fsync is what actually makes the rename survive a crash.
 */
function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode });

		// Windows: fsync can fail with EPERM even on files, especially when opened read-only.
		// The writeFileSync above already flushes to the OS buffer, which is usually sufficient.
		// For extra safety on non-Windows, we explicitly fsync the file.
		if (process.platform !== "win32") {
			try {
				const fd = openSync(tmp, "r");
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			} catch {
				// fsync may fail on some filesystems; continue anyway
			}
		}

		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// temp file may not exist yet; nothing to clean up
		}
		throw error;
	}

	// Directory fsync (non-Windows only)
	if (process.platform !== "win32") {
		try {
			const dirFd = openSync(dir, "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// fsync on a directory is not supported everywhere; the rename still landed
		}
	}
}

// Debounced config writer instance
let debouncedWriter: any = null;
let pendingConfig: RelayConfig | null = null;

function getDebouncedWriter() {
	if (!debouncedWriter) {
		try {
			const { ConfigWriter } = require("./performance.ts");
			debouncedWriter = new ConfigWriter();
		} catch {
			// performance.ts not available, return false to indicate unavailable
			return false;
		}
	}
	return debouncedWriter;
}

export function writeConfig(config: RelayConfig): void {
	// Backup config before writing (if config-v2.ts is available)
	try {
		const { getConfigRecoveryInstance } = require("./config-v2.ts");
		getConfigRecoveryInstance().backup(configPath());
	} catch {
		// config-v2.ts not available, skip backup
	}

	// Store pending config
	pendingConfig = config;

	// Use debounced writer if available
	const writer = getDebouncedWriter();
	if (writer) {
		writer.scheduleWrite(() => {
			if (pendingConfig) {
				atomicWriteJson(configPath(), pendingConfig);
				pendingConfig = null;
			}
		}, 500);
	} else {
		// Direct write if debouncing not available
		atomicWriteJson(configPath(), config);
		pendingConfig = null;
	}
}

export function writeConfigSync(config: RelayConfig): void {
	// Cancel any pending debounced write because we are writing immediately
	const writer = getDebouncedWriter();
	if (writer && typeof writer.cancel === "function") {
		writer.cancel();
	}
	pendingConfig = null;

	// Backup config before writing (if config-v2.ts is available)
	try {
		const { getConfigRecoveryInstance } = require("./config-v2.ts");
		getConfigRecoveryInstance().backup(configPath());
	} catch {
		// config-v2.ts not available, skip backup
	}

	atomicWriteJson(configPath(), config);
}

// Force immediate write (useful before exit)
export function flushConfig(): void {
	const writer = getDebouncedWriter();
	if (writer) {
		writer.flush();
	} else if (pendingConfig) {
		// Fallback: write pending config immediately
		atomicWriteJson(configPath(), pendingConfig);
		pendingConfig = null;
	}
}

// ---------------------------------------------------------------------------
// Scoped-models sync
// ---------------------------------------------------------------------------

function scopedModelsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Above this many models a wildcard keeps settings.json readable. */
const SCOPED_WILDCARD_THRESHOLD = 50;

function patternTargetsProvider(pattern: string, name: string): boolean {
	const model = pattern.replace(/:[a-z]+$/i, "");
	// A wildcard we wrote ourselves must stay reclaimable. Treating it as
	// foreign would pin every model of this gateway on forever — it would
	// survive dropping back under the threshold, and survive /ai-remove.
	if (model === `${name}/*`) return true;
	// Any other glob is user-authored; leave it alone.
	if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) return false;
	return model.startsWith(`${name}/`);
}

/**
 * Rebuild the scoped-model pattern list for one gateway.
 *
 * Pure so it can be tested without touching the real settings.json. Returns
 * undefined when the result is unchanged and no write is needed.
 */
export function computeScopedPatterns(
	existing: readonly string[] | undefined,
	name: string,
	enabledIds: readonly string[],
): string[] | undefined {
	// Drop every pattern this gateway owns — including a wildcard from an
	// earlier sync — then rebuild from the current enabled set.
	const keep = existing?.filter((pattern) => !patternTargetsProvider(pattern, name)) ?? [];
	const desired = enabledIds.map((id) => `${name}/${id}`);
	const merged = [
		...new Set(desired.length > SCOPED_WILDCARD_THRESHOLD ? [...keep, `${name}/*`] : [...keep, ...desired]),
	];

	if (existing !== undefined && [...existing].sort().join("\n") === [...merged].sort().join("\n")) return undefined;
	return merged;
}

/** Keep the file's current permissions; settings.json is pi's, not ours. */
function existingMode(path: string): number | undefined {
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return undefined;
	}
}

export function syncScopedModels(name: string, entry: RelayProviderEntry): void {
	const path = scopedModelsPath();
	let root: Record<string, unknown>;
	try {
		root = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) : {};
	} catch (error) {
		console.warn(
			`ai-gateway: could not read ${path}; scoped models not synced: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	const existing = Array.isArray(root.enabledModels)
		? root.enabledModels.filter((x): x is string => typeof x === "string")
		: undefined;
	const merged = computeScopedPatterns(existing, name, entry.enabledModels);
	if (merged === undefined) return;

	if (merged.length === 0) delete root.enabledModels;
	else root.enabledModels = merged;

	try {
		atomicWriteJson(path, root, existingMode(path) ?? 0o644);
	} catch (error) {
		console.warn(`ai-gateway: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}