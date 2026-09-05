// ---------------------------------------------------------------------------
// Duplicate model detection and comparison
// ---------------------------------------------------------------------------

import type { RelayConfig, DuplicateModelGroup, DuplicateModelInstance, HealthStatus } from "./types.ts";

export function normalizeModelName(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/^[^/]+\//, "")
		.replace(/[-_.](latest|instruct|chat|preview|free)$/g, "")
		.replace(/[^a-z0-9]+/g, "");
}

export function findDuplicateModels(config: RelayConfig): DuplicateModelGroup[] {
	const groups = new Map<string, DuplicateModelGroup>();
	for (const [gateway, entry] of Object.entries(config.providers)) {
		for (const modelId of entry.enabledModels) {
			const meta = entry.models[modelId];
			if (!meta) continue;
			const key = normalizeModelName(modelId);
			const group = groups.get(key) ?? { modelId, instances: [] };
			group.instances.push({ gateway, modelId, metrics: meta.metrics, health: meta.health });
			groups.set(key, group);
		}
	}
	return [...groups.values()].filter((group) => group.instances.length > 1);
}

/** Untested sorts ahead of known-broken; both lose to anything measured healthy. */
const HEALTH_RANK: Record<HealthStatus["status"], number> = { healthy: 0, degraded: 1, unknown: 2, down: 3 };

/**
 * Rank duplicate instances best-first. Health dominates latency deliberately —
 * ordering on response time alone lets an instance that fails every request
 * beat a healthy one purely by failing fast.
 */
export function compareInstances(a: DuplicateModelInstance, b: DuplicateModelInstance): number {
	const byHealth = HEALTH_RANK[a.health?.status ?? "unknown"] - HEALTH_RANK[b.health?.status ?? "unknown"];
	if (byHealth !== 0) return byHealth;
	return (a.metrics?.avgResponseTime ?? Number.POSITIVE_INFINITY) - (b.metrics?.avgResponseTime ?? Number.POSITIVE_INFINITY);
}