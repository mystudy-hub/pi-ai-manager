// ---------------------------------------------------------------------------
// Provider registration — builds ProviderModelConfig[] from RelayProviderEntry
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { RelayProviderEntry } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./types.ts";
import { compileOverrides, applyOverride, resolveApiBaseUrl, resolveApi, type DiscoveredModel } from "./network.ts";
import { inferReasoningSupport, inferThinkingLevelMap, inferModelCompat } from "./reasoning.ts";
import { canonicalBaseUrl, isSafeIdentifier, literalCredential, isEnvName } from "./security.ts";
import { validateName } from "./utils.ts";

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
): { added: number; updated: number } {
	const rules = compileOverrides(entry.modelApiOverrides ?? {});
	let added = 0;
	let updated = 0;
	for (const model of list) {
		if (!isSafeIdentifier(model.id)) continue;
		const existing = entry.models[model.id];
		if (existing) updated++;
		else added++;
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
	return { added, updated };
}

export function buildModelConfigs(entry: RelayProviderEntry, ids: readonly string[]): ProviderModelConfig[] {
	const rules = compileOverrides(entry.modelApiOverrides ?? {});
	const output: ProviderModelConfig[] = [];
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

		output.push({
			id,
			name: id,
			api,
			baseUrl: resolveApiBaseUrl(entry.baseUrl, api),
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
	pi.registerProvider(name, {
		name: `AI (${name})`,
		baseUrl,
		api: entry.defaultApi,
		// Pi gives runtime and /login credentials precedence over this configured key.
		...(apiKey !== undefined ? { apiKey } : {}),
		models: buildModelConfigs(entry, ids),
	});
	previous.set(name, apiKey !== undefined);
	credentialRegistrations.set(pi, previous);
}
