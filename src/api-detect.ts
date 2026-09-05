// ---------------------------------------------------------------------------
// Default-API auto-detection from discovery results
// ---------------------------------------------------------------------------

import type { RelayApi } from "./types.ts";
import { ENDPOINT_TYPE_TO_APIS } from "./types.ts";
import type { DiscoveredModel } from "./network.ts";

/**
 * Infer a gateway's default API from the models it reports.
 *
 * Most relays tag each model with `supported_endpoint_types`, which
 * resolveApi already uses per model; the default only kicks in for models
 * without types. When every model agrees on one family, that family wins.
 * "ambiguous" (empty list, untagged models, or a mix) means the caller should
 * ask the user — defaulting silently would route untagged models wrong.
 */
export function detectDefaultApi(models: readonly DiscoveredModel[]): RelayApi | "ambiguous" {
	let sawAnthropic = false;
	let sawOpenai = false;

	for (const model of models) {
		if (model.types.length === 0) return "ambiguous";
		for (const type of model.types) {
			const apis = ENDPOINT_TYPE_TO_APIS[type] ?? [];
			if (apis.includes("anthropic-messages")) sawAnthropic = true;
			if (apis.includes("openai-completions") || apis.includes("openai-responses")) sawOpenai = true;
		}
	}

	if (sawAnthropic && !sawOpenai) return "anthropic-messages";
	if (sawOpenai && !sawAnthropic) return "openai-completions";
	// Empty model list falls through here too: nothing was learned.
	return "ambiguous";
}
