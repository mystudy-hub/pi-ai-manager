// ---------------------------------------------------------------------------
// Provider registration — builds ProviderModelConfig[] from RelayProviderEntry
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RelayProviderEntry } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./types.ts";
import { compileOverrides, applyOverride, resolveApiBaseUrl, resolveApi, type DiscoveredModel } from "./network.ts";
import { inferReasoningSupport, inferThinkingLevelMap, inferModelCompat } from "./reasoning.ts";

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
		const existing = entry.models[model.id];
		if (existing) updated++;
		else added++;
		const api = resolveApi(model.types, model.id, entry, rules);
		const reasoning =
			existing?.reasoning !== undefined
				? existing.reasoning
				: model.reasoning !== undefined
					? model.reasoning
					: inferReasoningSupport(model.id);
		const thinkingLevelMap =
			existing?.thinkingLevelMap !== undefined
				? existing.thinkingLevelMap
				: reasoning
					? inferThinkingLevelMap(model.id)
					: undefined;
		const compat =
			existing?.compat !== undefined
				? existing.compat
				: reasoning
					? inferModelCompat(model.id, api)
					: undefined;

		entry.models[model.id] = {
			...existing,
			api,
			lastDiscovered: Date.now(),
			...(existing?.contextWindow !== undefined ? {} : model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
			...(existing?.maxTokens !== undefined ? {} : model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(compat ? { compat } : {}),
			...(existing?.input !== undefined ? {} : model.hasImageInput ? { input: ["text", "image"] as ("text" | "image")[] } : {}),
		};
	}
	return { added, updated };
}

export function buildModelConfigs(entry: RelayProviderEntry, ids: readonly string[]): ProviderModelConfig[] {
	const rules = compileOverrides(entry.modelApiOverrides ?? {});
	const output: ProviderModelConfig[] = [];
	for (const id of ids) {
		const meta = entry.models[id];
		if (!meta) continue;
		const api = applyOverride(id, meta.api, rules);
		const reasoning = meta.reasoning ?? inferReasoningSupport(id);
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
			input: meta.input ?? ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: meta.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: meta.maxTokens ?? DEFAULT_MAX_TOKENS,
		});
	}
	return output;
}

export function registerProviderFor(pi: ExtensionAPI, name: string, entry: RelayProviderEntry, idsOverride?: string[]): void {
	const ids = idsOverride ?? entry.enabledModels;
	pi.registerProvider(name, {
		name: `AI (${name})`,
		baseUrl: entry.baseUrl.replace(/\/+$/, ""),
		api: entry.defaultApi,
		// A literal key here takes precedence over a /login credential; without
		// one pi resolves auth from auth.json as before.
		...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
		models: buildModelConfigs(entry, ids),
	});
}