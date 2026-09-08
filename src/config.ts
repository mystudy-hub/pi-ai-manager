// ---------------------------------------------------------------------------
// Configuration Management — read, normalize, write (atomic), scoped-models
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HealthStatus, PerformanceMetrics, RelayApi, RelayConfig, RelayModelMeta, RelayProviderEntry, RelaySettings } from "./types.ts";
import { CONFIG_FILENAME, MAX_TEST_CONCURRENCY, SUPPORTED_APIS } from "./types.ts";
import { canonicalBaseUrl, isEnvName, isSafeIdentifier, isSafeProviderName, isTokenLimit } from "./security.ts";
import { settingsDirectory } from "./paths.ts";
import { atomicWrite } from "./storage.ts";
import { getConfigRecoveryInstance } from "./config-v2.ts";
export { canonicalBaseUrl } from "./security.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isRelayApi(value: unknown): value is RelayApi {
	return typeof value === "string" && SUPPORTED_APIS.has(value as RelayApi);
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
	const providers: Record<string, RelayProviderEntry> = Object.create(null);
	const rawProviders = (root.providers && typeof root.providers === "object" ? root.providers : {}) as Record<string, unknown>;

	for (const [name, value] of Object.entries(rawProviders)) {
		if (!isSafeProviderName(name) || !value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		// Preserve legacy HTTP entries for editing. Registration and requests enforce the opt-in.
		const baseUrl = typeof entry.baseUrl === "string" ? canonicalBaseUrl(entry.baseUrl, true) : "";
		if (!baseUrl) continue;

		const defaultApi: RelayApi = isRelayApi(entry.defaultApi) ? entry.defaultApi : "anthropic-messages";

		const modelApiOverrides: Record<string, RelayApi> = Object.create(null);
		if (entry.modelApiOverrides && typeof entry.modelApiOverrides === "object") {
			for (const [pattern, api] of Object.entries(entry.modelApiOverrides as Record<string, unknown>)) {
				if (isRelayApi(api)) modelApiOverrides[pattern] = api;
			}
		}

		const models: Record<string, RelayModelMeta> = Object.create(null);
		if (entry.models && typeof entry.models === "object") {
			for (const [id, meta] of Object.entries(entry.models as Record<string, unknown>)) {
				if (!isSafeIdentifier(id) || !meta || typeof meta !== "object") continue;
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
					...(isRelayApi(m.discoveredApi) ? { discoveredApi: m.discoveredApi } : {}),
					...(normalizeCost(m.cost) ? { cost: normalizeCost(m.cost) } : {}),
					...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					...(thinkingMode ? { thinkingMode } : {}),
					...(thinkingEffort ? { thinkingEffort } : {}),
					...(compat ? { compat } : {}),
					...(isTokenLimit(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
					...(isTokenLimit(m.maxTokens) ? { maxTokens: m.maxTokens } : {}),
					...(input && input.length > 0 ? { input } : {}),
					health: normalizeHealthStatus(m.health),
					metrics: normalizeMetrics(m.metrics),
					...(typeof m.lastDiscovered === "number" ? { lastDiscovered: m.lastDiscovered } : {}),
				};
			}
		}

		const enabledModels = (Array.isArray(entry.enabledModels) ? entry.enabledModels : [])
			.filter((x): x is string => typeof x === "string")
			.filter((id) => Object.hasOwn(models, id));

		providers[name] = {
			baseUrl,
			...(typeof entry.apiKey === "string" && entry.apiKey ? { apiKey: entry.apiKey } : {}),
			...(isEnvName(entry.apiKeyEnv) ? { apiKeyEnv: entry.apiKeyEnv } : {}),
			...(entry.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
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
	if (Number.isFinite(requestDelay) && requestDelay >= 0) settings.testRequestDelayMs = Math.min(requestDelay, 10_000);
	const concurrency = typeof rawSettings.testConcurrency === "number" ? Math.round(rawSettings.testConcurrency) : NaN;
	if (Number.isFinite(concurrency) && concurrency > 0) settings.testConcurrency = Math.min(concurrency, MAX_TEST_CONCURRENCY);

	return { version: 1, providers, settings };
}

export function normalizeCost(raw: unknown): RelayModelMeta["cost"] {
	if (!raw || typeof raw !== "object") return undefined;
	const cost = raw as Record<string, unknown>;
	if (![cost.input, cost.output].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
	const validRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
	return { input: validRate(cost.input), output: validRate(cost.output), cacheRead: validRate(cost.cacheRead), cacheWrite: validRate(cost.cacheWrite) };
}

export function configPath(): string {
	return join(settingsDirectory(), CONFIG_FILENAME);
}

export function emptyConfig(): RelayConfig {
	return { version: 1, providers: Object.create(null), settings: {} };
}

export function cloneConfig(config: RelayConfig): RelayConfig {
	return normalizeConfig(JSON.parse(JSON.stringify(config)));
}

function parseConfig(content: string): RelayConfig {
	const raw = JSON.parse(content);
	if (!raw || Array.isArray(raw) || typeof raw !== "object" || raw.version !== 1 ||
		!raw.providers || Array.isArray(raw.providers) || typeof raw.providers !== "object") {
		throw new Error("Invalid provider configuration structure or unsupported version");
	}
	return normalizeConfig(raw);
}

function withFileLock<T>(path: string, operation: () => T): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let release: () => void;
	try { release = lockfile.lockSync(path, { realpath: false }); }
	catch { throw new Error("Another process is saving these settings. Retry after it finishes."); }
	try { return operation(); } finally { release(); }
}

/** Read-only snapshot used when restoring runtime registrations after cancellation. */
export function readCurrentConfig(): RelayConfig {
	if (!existsSync(configPath())) return emptyConfig();
	try { return parseConfig(readFileSync(configPath(), "utf8")); }
	catch { throw new Error("Provider configuration is invalid. Restore a valid backup before saving."); }
}

export function readConfig(): RelayConfig {
	let config: RelayConfig;
	try { config = readCurrentConfig(); }
	catch {
		config = withFileLock(configPath(), () => {
			// Another process may have repaired the file while the lock was acquired.
			try { return readCurrentConfig(); } catch { /* Try a validated backup below. */ }
			const backup = getConfigRecoveryInstance().tryRecover(configPath(), parseConfig);
			if (backup) return parseConfig(backup.content);
			throw new Error("Provider configuration is invalid and no valid backup is available. The original file was kept.");
		});
	}
	// Recovery must precede journal replay, which reads the current provider file.
	if (existsSync(journalPath())) {
		repairPendingSync();
		return readCurrentConfig();
	}
	return config;
}

/** Explicit writes retained for callers outside the TUI. Draft edits never call this. */
export function writeConfigSync(config: RelayConfig): void {
	withFileLock(configPath(), () => {
		getConfigRecoveryInstance().backup(configPath());
		atomicWrite(configPath(), JSON.stringify(config, null, 2));
	});
}
export const writeConfig = writeConfigSync;
/** Writes are now explicit and synchronous; there is no pending draft timer. */
export function flushConfig(): void {}

function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left).filter(key => left[key] !== undefined);
	return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length &&
		keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge independent edits; conflicting metadata changes must never silently win. */
export function mergeConfig(base: RelayConfig, draft: RelayConfig, current: RelayConfig): RelayConfig {
	function merge(before: unknown, wanted: unknown, latest: unknown, path: string[]): unknown {
		if (same(before, wanted)) return latest;
		if (same(before, latest) || same(wanted, latest)) return wanted;
		const field = path.at(-1);
		if (field === "enabledModels" && path.length === 4 && Array.isArray(before) && Array.isArray(wanted) && Array.isArray(latest)) {
			const removed = new Set(before.filter(id => !wanted.includes(id)));
			return [...new Set([...latest.filter(id => !removed.has(id)), ...wanted.filter(id => !before.includes(id))])];
		}
		if (path.length === 6 && record(wanted) && record(latest)) {
			if (field === "health") return Number(wanted.lastCheck ?? 0) >= Number(latest.lastCheck ?? 0) ? wanted : latest;
			if (field === "metrics") return Number(wanted.timestamp ?? 0) >= Number(latest.timestamp ?? 0) ? wanted : latest;
		}
		if (record(before) && record(wanted) && record(latest)) {
			// Never combine one session's endpoint with another session's credential.
			const routingFields = ["baseUrl", "apiKey", "apiKeyEnv", "allowInsecureHttp", "defaultApi"];
			if (path.length === 3 && path[1] === "providers") {
				const routing = (entry: Record<string, unknown>) => Object.fromEntries(routingFields.map(key => [key, entry[key]]));
				if (!same(routing(before), routing(wanted)) && !same(routing(before), routing(latest)) && !same(routing(wanted), routing(latest))) {
					throw new Error(`Configuration conflict at ${path.join(".")}: gateway connection or credentials changed in another session.`);
				}
			}
			const output: Record<string, unknown> = Object.create(null);
			for (const key of new Set([...Object.keys(before), ...Object.keys(wanted), ...Object.keys(latest)])) {
				const value = merge(before[key], wanted[key], latest[key], [...path, key]);
				if (value !== undefined) output[key] = value;
			}
			return output;
		}
		if (field === "lastDiscovered" && path.length === 6 && typeof wanted === "number" && typeof latest === "number") return Math.max(wanted, latest);
		throw new Error(`Configuration conflict at ${path.join(".")}. Reopen the manager to reconcile the other session's changes.`);
	}
	return normalizeConfig(merge(base, draft, current, ["config"]));
}

function scopedModelsPath(): string { return join(getAgentDir(), "settings.json"); }
function journalPath(): string { return join(settingsDirectory(), "provider-ai.pending.json"); }

function readSettings(): Record<string, unknown> {
	if (!existsSync(scopedModelsPath())) return {};
	try {
		const root = JSON.parse(readFileSync(scopedModelsPath(), "utf8"));
		if (!record(root)) throw new Error();
		return root;
	} catch { throw new Error("Pi settings.json is invalid; changes were not saved. Repair this file and retry."); }
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

function syncSettings(root: Record<string, unknown>, names: readonly string[], config: RelayConfig): void {
	let patterns = Array.isArray(root.enabledModels) ? root.enabledModels.filter((x): x is string => typeof x === "string") : undefined;
	for (const name of names) {
		patterns = computeScopedPatterns(patterns, name, config.providers[name]?.enabledModels ?? []) ?? patterns;
	}
	if (patterns?.length) root.enabledModels = patterns;
	else delete root.enabledModels;
	const path = scopedModelsPath();
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	atomicWrite(path, JSON.stringify(root, null, 2), mode);
}

/** The journal contains only provider names, never API keys. Replay after an interrupted save. */
function repairPendingSyncLocked(): void {
	if (!existsSync(journalPath())) return;
	const pending = JSON.parse(readFileSync(journalPath(), "utf8")) as { providers?: unknown };
	if (!Array.isArray(pending.providers) || !pending.providers.every(isSafeProviderName)) throw new Error("Invalid pending settings sync journal");
	const config = readCurrentConfig();
	withFileLock(scopedModelsPath(), () => syncSettings(readSettings(), pending.providers as string[], config));
	unlinkSync(journalPath());
}

export function repairPendingSync(): void {
	if (existsSync(journalPath())) withFileLock(configPath(), repairPendingSyncLocked);
}

export function commitConfig(base: RelayConfig, draft: RelayConfig): RelayConfig {
	return withFileLock(configPath(), () => {
		repairPendingSyncLocked();
		const current = readCurrentConfig();
		const merged = mergeConfig(base, draft, current);
		const names = [...new Set([...Object.keys(base.providers), ...Object.keys(current.providers), ...Object.keys(merged.providers)])];
		withFileLock(scopedModelsPath(), () => {
			const settings = readSettings(); // Validate before writing either file.
			getConfigRecoveryInstance().backup(configPath());
			atomicWrite(journalPath(), JSON.stringify({ providers: names }));
			atomicWrite(configPath(), JSON.stringify(merged, null, 2));
			try { syncSettings(settings, names, merged); }
			catch { throw new Error("Provider configuration was saved, but Pi settings sync failed. Retry saving; the pending sync will be repaired automatically."); }
			unlinkSync(journalPath());
		});
		return merged;
	});
}

export function syncScopedModels(name: string, entry: RelayProviderEntry): void {
	withFileLock(scopedModelsPath(), () => syncSettings(readSettings(), [name], { version: 1, providers: { [name]: entry }, settings: {} }));
}
