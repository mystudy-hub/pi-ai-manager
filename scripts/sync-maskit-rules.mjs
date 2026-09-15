#!/usr/bin/env node
/**
 * Data Maskit Rule Sync & Diagnostic Tool
 *
 * Compares current local rules in src/shield/rules.ts against upstream Maskit repository:
 * https://github.com/xiaYuTian11/maskit
 *
 * Usage:
 *   node scripts/sync-maskit-rules.mjs
 */

import { UPSTREAM_MASKIT_REPO, BUILTIN_RULES, DEFAULT_BUILTIN_RULES } from "../src/shield/rules.ts";
import { syncMaskitRules, syncedRulesPath, fetchUpstreamMaskitCode, parseMaskitPythonCode } from "../src/shield/sync.ts";

const applyUpdate = process.argv.includes("--apply") || process.argv.includes("--update");

console.log("==================================================================");
console.log("  Data Maskit Rule Sync & Inspector for pi-ai-manager");
console.log(`  Upstream Repository: ${UPSTREAM_MASKIT_REPO}`);
console.log("==================================================================\n");

async function checkUpstream() {
	console.log(`[1/3] Current local rules: ${BUILTIN_RULES.length} rules loaded.`);
	const localLabels = Array.from(new Set(BUILTIN_RULES.map((r) => r.label)));
	console.log(`      Categories (${localLabels.length}):`, localLabels.join(", "));

	console.log(`\n[2/3] Fetching latest rules from upstream repository...`);
	try {
		const { code, url } = await fetchUpstreamMaskitCode();
		console.log(`      ✓ Successfully fetched transparent.py from:\n        ${url} (${code.length} bytes).`);

		const { rules } = parseMaskitPythonCode(code);
		const upstreamLabels = Array.from(new Set(rules.map((r) => r.label)));

		console.log(`\n[3/3] Comparison result:`);
		console.log(`      Upstream rules parsed: ${rules.length} (across ${upstreamLabels.length} categories)`);

		const missingInLocal = upstreamLabels.filter((l) => !localLabels.includes(l));
		const extraInLocal = localLabels.filter((l) => !upstreamLabels.includes(l));

		if (missingInLocal.length > 0) {
			console.log(`\n      ⚠️ Found NEW categories in upstream Maskit:`, missingInLocal.join(", "));
			console.log(`      Run 'npm run sync-shield --apply' to synchronize automatically.`);
		} else {
			console.log(`\n      ✅ All upstream rule categories are fully covered locally!`);
		}

		if (extraInLocal.length > 0) {
			console.log(`      (Local extensions: ${extraInLocal.join(", ")})`);
		}

		if (applyUpdate) {
			console.log(`\n[Apply] Performing one-click rule synchronization from Maskit...`);
			const res = await syncMaskitRules();
			console.log(`      ✓ Saved ${res.totalRules} rules to: ${syncedRulesPath()}`);
			console.log(`      ✓ Rules updated and active in pi-ai-manager!`);
		} else {
			console.log(`\n      Tip: Run 'node scripts/sync-maskit-rules.mjs --apply' to fetch and apply latest rules to local settings.`);
		}
	} catch (err) {
		console.log(`      ⚠️ Network check failed: ${err.message || err}`);
		console.log(`      You can manually inspect: https://github.com/xiaYuTian11/maskit/blob/master/engine/transparent.py`);
	}
}

checkUpstream().catch(console.error);
