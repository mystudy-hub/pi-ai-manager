/**
 * Data Maskit - One-Click Rule Synchronization Engine
 * Automatically fetches, parses, and updates rules from upstream:
 * https://github.com/xiaYuTian11/maskit
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { BUILTIN_RULES, type BuiltinRuleDef } from "./rules.ts";

export const UPSTREAM_URLS = [
	"https://cdn.jsdelivr.net/gh/xiaYuTian11/maskit@master/engine/transparent.py",
	"https://raw.githubusercontent.com/xiaYuTian11/maskit/master/engine/transparent.py",
];

export interface SyncedRuleDef {
	label: string;
	pattern: string;
	group: number;
	ignoreCase: boolean;
	markers?: string[];
}

export interface SyncResult {
	success: boolean;
	totalRules: number;
	newCategories: string[];
	sourceUrl: string;
	error?: string;
}

export function syncedRulesPath(): string {
	const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "extension-settings", "maskit-synced-rules.json");
}

/**
 * Parses Python regex tuples and markers from Maskit's transparent.py.
 */
export function parseMaskitPythonCode(code: string): { rules: SyncedRuleDef[]; markers: Record<string, string[]> } {
	const rulesMatch = code.match(/RULES\s*=\s*\[([\s\S]*?)\n\]/);
	if (!rulesMatch) {
		throw new Error("Could not find RULES array in Maskit transparent.py");
	}

	// Extract _RULE_MARKERS dictionary if present
	const markersMatch = code.match(/_RULE_MARKERS\s*=\s*\{([\s\S]*?)\n\}/);
	const markers: Record<string, string[]> = {};
	if (markersMatch) {
		const markerItemRx = /"([A-Z_]+)"\s*:\s*\((.*?)\)/g;
		let mm: RegExpExecArray | null;
		while ((mm = markerItemRx.exec(markersMatch[1] || "")) !== null) {
			const label = mm[1]!;
			const values = Array.from(mm[2]!.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
			markers[label] = values;
		}
	}

	const rules: SyncedRuleDef[] = [];
	const itemRx = /\(\s*re\.compile\(([\s\S]*?)\)\s*,\s*"([A-Za-z0-9_]+)"\s*,\s*(\d+)\s*\)/g;

	let match: RegExpExecArray | null;
	while ((match = itemRx.exec(rulesMatch[1] || "")) !== null) {
		const rawCompiled = match[1]!;
		const label = match[2]!;
		const group = parseInt(match[3]!, 10);

		let ignoreCase = rawCompiled.includes("re.IGNORECASE") || rawCompiled.includes("re.I");

		const strRx = /r?("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|ID_BOUND_L|ID_BOUND_R|IP_BOUND_R/g;
		let fullPattern = "";
		let sm: RegExpExecArray | null;

		while ((sm = strRx.exec(rawCompiled)) !== null) {
			const token = sm[0];
			if (token === "ID_BOUND_L") {
				fullPattern += "(?<![A-Za-z0-9])";
			} else if (token === "ID_BOUND_R") {
				fullPattern += "(?![A-Za-z0-9])";
			} else if (token === "IP_BOUND_R") {
				fullPattern += "(?![A-Za-z0-9]|\\.\\d)";
			} else {
				let s = token;
				if (s.startsWith("r")) s = s.slice(1);
				if (s.startsWith('"""') || s.startsWith("'''")) {
					s = s.slice(3, -3);
				} else {
					s = s.slice(1, -1);
				}
				s = s.replace(/\\(["'])/g, "$1");
				fullPattern += s;
			}
		}

		if (fullPattern.startsWith("(?i)")) {
			ignoreCase = true;
			fullPattern = fullPattern.slice(4);
		}

		// Enhancement: extend secret keyword to also cover secret_key / secret-key
		if (label === "SECRET" && fullPattern.includes("|secret|")) {
			fullPattern = fullPattern.replace(/\|secret\|/g, "|secret(?:[_-]?key)?|");
		}

		// Validate that the extracted pattern is a valid JavaScript RegExp
		try {
			new RegExp(fullPattern, ignoreCase ? "gi" : "g");
			rules.push({
				label,
				group,
				pattern: fullPattern,
				ignoreCase,
				markers: markers[label],
			});
		} catch (err: any) {
			console.warn(`[shield-sync] Skipped invalid regex for ${label}: ${err.message}`);
		}
	}

	return { rules, markers };
}

/**
 * Fetches the upstream code from primary CDN or fallback URL.
 */
export async function fetchUpstreamMaskitCode(): Promise<{ code: string; url: string }> {
	for (const url of UPSTREAM_URLS) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 12000);
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timeout);
			if (res.ok) {
				const code = await res.text();
				if (code && code.includes("RULES =")) {
					return { code, url };
				}
			}
		} catch {
			// Try fallback URL
		}
	}

	// Secondary fallback: attempt via curl if native fetch was blocked
	for (const url of UPSTREAM_URLS) {
		try {
			const code = execSync(`curl -sL --max-time 15 "${url}"`, { encoding: "utf-8" });
			if (code && code.includes("RULES =")) {
				return { code, url };
			}
		} catch {
			// continue
		}
	}

	throw new Error("Failed to connect to Maskit repository across all mirrors. Please check network connection.");
}

// In-memory cache for dynamically synced rules
let inMemorySyncedRules: BuiltinRuleDef[] | null = null;

/**
 * Loads previously synced rules from maskit-synced-rules.json.
 */
export function loadSyncedRules(): BuiltinRuleDef[] | null {
	if (inMemorySyncedRules) return inMemorySyncedRules;
	const p = syncedRulesPath();
	if (!existsSync(p)) return null;

	try {
		const content = readFileSync(p, "utf-8");
		const data = JSON.parse(content) as { rules: SyncedRuleDef[] };
		if (Array.isArray(data.rules) && data.rules.length > 0) {
			inMemorySyncedRules = data.rules.map((r) => ({
				label: r.label,
				regex: new RegExp(r.pattern, r.ignoreCase ? "gi" : "g"),
				captureGroup: r.group,
				mayHitMarkers: r.markers,
			}));
			return inMemorySyncedRules;
		}
	} catch {
		// Ignore corrupt sync file
	}
	return null;
}

/**
 * Executes a one-click synchronization from Maskit.
 * Fetches latest upstream, parses rules, saves to settings, and reloads in-memory rules.
 */
export async function syncMaskitRules(): Promise<SyncResult> {
	const { code, url } = await fetchUpstreamMaskitCode();
	const { rules } = parseMaskitPythonCode(code);

	if (rules.length === 0) {
		throw new Error("No rules were extracted from upstream repository.");
	}

	// Identify any new categories compared to built-in set
	const localLabels = new Set(BUILTIN_RULES.map((r) => r.label));
	const newCategories = Array.from(new Set(rules.map((r) => r.label))).filter((l) => !localLabels.has(l));

	// Save to extension settings
	const savePayload = {
		version: 1,
		updatedAt: new Date().toISOString(),
		source: url,
		rules,
	};
	writeFileSync(syncedRulesPath(), JSON.stringify(savePayload, null, 2), "utf-8");

	// Update in-memory cache immediately
	inMemorySyncedRules = rules.map((r) => ({
		label: r.label,
		regex: new RegExp(r.pattern, r.ignoreCase ? "gi" : "g"),
		captureGroup: r.group,
		mayHitMarkers: r.markers,
	}));

	return {
		success: true,
		totalRules: rules.length,
		newCategories,
		sourceUrl: url,
	};
}
