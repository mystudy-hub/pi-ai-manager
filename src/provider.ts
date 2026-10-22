// ---------------------------------------------------------------------------
// Provider registration — builds ProviderModelConfig[] from RelayProviderEntry
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { RelayProviderEntry } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, ENDPOINT_TYPE_TO_APIS, SUPPORTED_APIS } from "./types.ts";
import { compileOverrides, applyOverride, resolveApiBaseUrl, resolveApi, type DiscoveredModel } from "./network.ts";
import { inferReasoningSupport, inferThinkingLevelMap, inferModelCompat } from "./reasoning.ts";
import { canonicalBaseUrl, isSafeIdentifier, literalCredential, isEnvName } from "./security.ts";
import { validateName } from "./utils.ts";
import { getGlobalShieldProxy } from "./shield/proxy.ts";

type ModelDefaults = Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "input" | "reasoning">;
let catalogue: Map<string, ModelDefaults> | undefined;

function catalogueModel(id: string): ModelDefaults | undefined {
	if (!catalogue) {
		catalogue = new Map();
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				catalogue.set(`${provider}/${model.id}`, model);
				if (!catalogue.has(model.id)) catalogue.set(model.id, model);
			}
		}
	}
	return catalogue.get(id);
}

export function modelLimits(entry: RelayProviderEntry, id: string): { contextWindow: number; maxTokens: number; estimated: boolean } {
	const meta = entry.models[id];
	const known = catalogueModel(id);
	const contextWindow = meta?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	return {
		contextWindow,
		maxTokens: Math.min(meta?.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow),
		estimated: meta?.contextWindow === undefined && known?.contextWindow === undefined,
	};
}

export async function providerApiKey(ctx: ExtensionCommandContext, name: string, entry: RelayProviderEntry): Promise<string | undefined> {
	// Match Pi's request precedence while letting an unsaved form supply its draft key.
	const status = ctx.modelRegistry.getProviderAuthStatus(name);
	if (status.source === "stored" || status.source === "runtime") {
		const resolved = await ctx.modelRegistry.getProviderAuth(name);
		if (!resolved?.auth.apiKey) throw new Error(`Pi credential for ${name} could not be resolved for discovery`);
		return resolved.auth.apiKey;
	}
	if (entry.apiKeyEnv) {
		if (!isEnvName(entry.apiKeyEnv) || !process.env[entry.apiKeyEnv]) throw new Error(`Environment variable ${entry.apiKeyEnv} is not configured`);
		return process.env[entry.apiKeyEnv];
	}
	if (entry.apiKey) return entry.apiKey;
	// A form may have just cleared its key. Do not rediscover using the old registration.
	if (ctx.modelRegistry.getRegisteredProviderConfig(name)?.apiKey !== undefined) return undefined;
	return status.configured ? (await ctx.modelRegistry.getProviderAuth(name))?.auth.apiKey : undefined;
}

export function hasProviderAuth(ctx: ExtensionCommandContext, name: string, entry: RelayProviderEntry): boolean {
	const status = ctx.modelRegistry.getProviderAuthStatus(name);
	if (status.source === "stored" || status.source === "runtime") return true;
	if (entry.apiKeyEnv) return isEnvName(entry.apiKeyEnv) && !!process.env[entry.apiKeyEnv];
	if (entry.apiKey) return true;
	return ctx.modelRegistry.getRegisteredProviderConfig(name)?.apiKey === undefined && status.configured;
}

export function modelReasoning(entry: RelayProviderEntry, id: string): boolean {
	return entry.models[id]?.reasoning ?? catalogueModel(id)?.reasoning ?? inferReasoningSupport(id);
}

export interface GatewaySyncResult {
	gateway: string;
	totalRemote: number;
	addedModels: string[];
	updatedModels: string[];
	/** Models deleted from the entry: absent upstream or exposed only over an unusable protocol. */
	removedModels: string[];
	/** Remote models skipped because every endpoint type they advertise is unsupported. */
	unsupportedModels: string[];
	/** True when a prune was suppressed because the response could not be a usable catalogue. */
	removalSkipped: boolean;
	timestamp: number;
}

/**
 * A discovered model is unusable when the gateway tags it with endpoint types and
 * none of them map to a protocol Pi can speak. Untagged models stay: an absent
 * tag is not evidence against the model, so the gateway default still applies.
 */
export function isUnsupportedDiscovery(model: DiscoveredModel): boolean {
	if (model.types.length === 0) return false;
	for (const type of model.types) {
		const apis = Object.hasOwn(ENDPOINT_TYPE_TO_APIS, type) ? ENDPOINT_TYPE_TO_APIS[type] : [];
		if (apis.some(api => SUPPORTED_APIS.has(api))) return false;
	}
	return true;
}

/**
 * Sync and merge discovery results into a provider entry in place.
 *
 * Models disappear again as well: anything the gateway no longer lists, and
 * anything it lists only over an unsupported protocol, is dropped from both
 * `models` and `enabledModels`. Only entries carrying a discovery stamp are
 * pruned, so a hand-written model that the gateway never lists is never
 * silently retired. Pruning is skipped when the response cannot be a usable
 * catalogue (empty, or without a single supported model), which keeps a
 * gateway glitch from turning into a wiped model list; callers surface that as
 * `removalSkipped`.
 */
export function syncProviderModels(
	entry: RelayProviderEntry,
	list: readonly DiscoveredModel[],
	gatewayName: string = "gateway",
): GatewaySyncResult {
	const rules = compileOverrides(entry.modelApiOverrides ?? {});
	const remoteIds = new Set<string>();
	const addedModels: string[] = [];
	const updatedModels: string[] = [];
	const unsupportedModels: string[] = [];

	for (const model of list) {
		if (!isSafeIdentifier(model.id)) continue;
		if (isUnsupportedDiscovery(model)) {
			unsupportedModels.push(model.id);
			continue;
		}
		remoteIds.add(model.id);
		const existing = entry.models[model.id];
		if (existing) {
			updatedModels.push(model.id);
		} else {
			addedModels.push(model.id);
		}

		const api = resolveApi(model.types, model.id, entry, rules);
		const reasoning =
			existing?.reasoning !== undefined
				? existing.reasoning
				: model.reasoning !== undefined
					? model.reasoning
					: catalogueModel(model.id)?.reasoning ?? inferReasoningSupport(model.id);
		const thinkingLevelMap =
			existing?.thinkingLevelMap !== undefined
				? existing.thinkingLevelMap
				: reasoning
					? inferThinkingLevelMap(model.id)
					: undefined;

		entry.models[model.id] = {
			...existing,
			api,
			discoveredApi: resolveApi(model.types, model.id, entry, []),
			lastDiscovered: Date.now(),
			...(existing?.contextWindow !== undefined ? {} : model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
			...(existing?.maxTokens !== undefined ? {} : model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(existing?.thinkingMode !== undefined ? {} : model.thinkingMode !== undefined ? { thinkingMode: model.thinkingMode } : {}),
			...(existing?.thinkingEffort !== undefined ? {} : model.thinkingEffort !== undefined ? { thinkingEffort: model.thinkingEffort } : {}),
			...(existing?.input !== undefined ? {} : model.hasImageInput ? { input: ["text", "image"] as ("text" | "image")[] } : {}),
		};
	}

	const prunable = Object.keys(entry.models).filter((id) => entry.models[id]?.lastDiscovered !== undefined);
	// Two responses must never trigger a prune: an empty catalogue (discovery was
	// probably rejected or truncated) and one whose every model is unsupported
	// (the gateway most likely changed its metadata, not its whole catalogue).
	const removalSkipped = list.length === 0 || (remoteIds.size === 0 && prunable.length > 0);
	const removedModels = removalSkipped
		? []
		: prunable.filter((id) => !remoteIds.has(id));

	for (const id of removedModels) delete entry.models[id];
	if (removedModels.length > 0) {
		const removed = new Set(removedModels);
		entry.enabledModels = entry.enabledModels.filter((id) => !removed.has(id));
	}

	return {
		gateway: gatewayName,
		totalRemote: list.length,
		addedModels,
		updatedModels,
		removedModels,
		unsupportedModels,
		removalSkipped,
		timestamp: Date.now(),
	};
}

/**
 * Merge a discovery result into a provider entry, in place.
 *
 * Discovered values only fill gaps: anything already stored wins, so a manual
 * contextWindow edit is not clobbered on the next refresh. Spreading `existing`
 * first is what preserves health and metrics across a re-discovery.
 */
export function applyDiscovery(
	entry: RelayProviderEntry,
	list: readonly DiscoveredModel[],
): { added: number; updated: number; removed: number } {
	const res = syncProviderModels(entry, list);
	return { added: res.addedModels.length, updated: res.updatedModels.length, removed: res.removedModels.length };
}

export function buildModelConfigs(entry: RelayProviderEntry, ids: readonly string[], baseUrlOverride?: string, gatewayName?: string): ProviderModelConfig[] {
	const rules = compileOverrides(entry.modelApiOverrides ?? {});
	const output: ProviderModelConfig[] = [];
	const proxy = getGlobalShieldProxy();
	const base = baseUrlOverride ?? entry.baseUrl;
	for (const id of ids) {
		if (!isSafeIdentifier(id) || !Object.hasOwn(entry.models, id)) continue;
		const meta = entry.models[id];
		if (!meta) continue;
		const api = applyOverride(id, meta.api, rules);
		const known = catalogueModel(id);
		const limits = modelLimits(entry, id);
		const reasoning = modelReasoning(entry, id);
		const thinkingLevelMap = meta.thinkingLevelMap ?? (reasoning ? inferThinkingLevelMap(id) : undefined);
		const compat = meta.compat ?? (reasoning ? inferModelCompat(id, api) : undefined);

		// Per-model shield decision:
		// Model-level setting (meta.shield) takes precedence; if undefined, inherits gateway setting.
		const isShielded = meta.shield ?? entry.shield?.enabled ?? false;
		let effectiveModelBase = base;
		if (gatewayName && proxy.isRunning()) {
			effectiveModelBase = isShielded ? proxy.getLocalBaseUrl(gatewayName) : entry.baseUrl;
		}

		output.push({
			id,
			name: id,
			api,
			baseUrl: resolveApiBaseUrl(effectiveModelBase, api),
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap: thinkingLevelMap as any } : {}),
			...(compat ? { compat: compat as any } : {}),
			...(meta.thinkingMode ? { thinkingMode: meta.thinkingMode } : {}),
			...(meta.thinkingEffort ? { thinkingEffort: meta.thinkingEffort } : {}),
			input: meta.input ?? known?.input ?? ["text"],
			// Pi requires numeric rates. The manager explicitly labels this fallback as unknown.
			cost: meta.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: limits.contextWindow,
			maxTokens: limits.maxTokens,
		});
	}
	return output;
}

const credentialRegistrations = new WeakMap<ExtensionAPI, Map<string, boolean>>();

export function registerProviderFor(pi: ExtensionAPI, name: string, entry: RelayProviderEntry, idsOverride?: string[]): void {
	const error = validateName(name);
	if (error) throw new Error(error);
	const baseUrl = canonicalBaseUrl(entry.baseUrl, entry.allowInsecureHttp);
	if (!baseUrl) throw new Error(`Gateway ${name} requires a valid HTTPS URL or an explicit HTTP opt-in`);
	const apiKey = entry.apiKeyEnv && isEnvName(entry.apiKeyEnv)
		? "${" + entry.apiKeyEnv + "}"
		: entry.apiKey ? literalCredential(entry.apiKey) : undefined;
	const previous = credentialRegistrations.get(pi) ?? new Map<string, boolean>();
	// Pi merges re-registrations: omitting a key alone would retain the previous key.
	if (previous.get(name) && apiKey === undefined) pi.unregisterProvider(name);
	const ids = idsOverride ?? entry.enabledModels;

	const hasAnyShielded = Boolean(entry.shield?.enabled || ids.some((id) => entry.models[id]?.shield === true));
	let effectiveBaseUrl = baseUrl;
	if (hasAnyShielded) {
		const proxy = getGlobalShieldProxy();
		// Proxy must already be running (started by index.ts before this loop).
		// If not running, skip shield routing — the provider will use the original baseUrl.
		if (proxy.isRunning()) {
			proxy.registerUpstream({
				name,
				targetBaseUrl: baseUrl,
				options: {
					rules: entry.shield?.rules as any,
					customWords: entry.shield?.customWords,
					customRules: entry.shield?.customRules,
					maskToolArguments: entry.shield?.maskToolArguments,
				},
			});
			if (entry.shield?.enabled) {
				effectiveBaseUrl = proxy.getLocalBaseUrl(name);
			}
		}
	} else {
		getGlobalShieldProxy().unregisterUpstream(name);
	}

	pi.registerProvider(name, {
		name: entry.shield?.enabled ? `AI (${name}) 🛡️` : `AI (${name})`,
		baseUrl: effectiveBaseUrl,
		api: entry.defaultApi,
		// Pi gives runtime and /login credentials precedence over this configured key.
		...(apiKey !== undefined ? { apiKey } : {}),
		models: buildModelConfigs(entry, ids, effectiveBaseUrl, name),
	});
	previous.set(name, apiKey !== undefined);
	credentialRegistrations.set(pi, previous);
}
