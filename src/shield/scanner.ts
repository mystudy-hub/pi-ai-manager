/**
 * Data Maskit - Privacy Shield Engine: Text Scanner & Masker
 * Scans text and replaces sensitive credentials, PII, and custom words with structured placeholders.
 */

import {
	BUILTIN_RULES,
	DEFAULT_BUILTIN_RULES,
	DEFAULT_SECRET_PREFIXES,
	isCardValid,
	isConnStrPasswordValid,
	isEmailValid,
	isIbanValid,
	isIdCardValid,
	isJwtValid,
	isPhoneValid,
	ruleMayHit,
	type BuiltinRuleLabel,
} from "./rules.ts";
import { loadSyncedRules } from "./sync.ts";
import { PLACEHOLDER_RX, ShieldVault } from "./vault.ts";

export interface CustomRuleDef {
	label: string;
	pattern: string;
	flags?: string;
}

export interface ScannerOptions {
	rules?: Partial<Record<BuiltinRuleLabel, boolean>>;
	secretPrefixes?: readonly string[];
	customWords?: readonly string[] | Record<string, string>;
	customRules?: readonly CustomRuleDef[];
}

/**
 * Splits text into placeholder and non-placeholder segments,
 * running regex substitution ONLY on non-placeholder segments.
 */
export function maskExcludingPlaceholders(
	text: string,
	rx: RegExp,
	subFn: (match: RegExpExecArray) => string
): string {
	if (!text) return text;

	// Reset global regex states
	const placeholderRegex = new RegExp(PLACEHOLDER_RX.source, "g");
	const matches: Array<{ start: number; end: number; text: string }> = [];
	let m: RegExpExecArray | null;

	while ((m = placeholderRegex.exec(text)) !== null) {
		matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}

	if (matches.length === 0) {
		return replaceAll(text, rx, subFn);
	}

	const parts: string[] = [];
	let lastEnd = 0;

	for (const match of matches) {
		if (match.start > lastEnd) {
			const segment = text.slice(lastEnd, match.start);
			parts.push(replaceAll(segment, rx, subFn));
		}
		parts.push(match.text); // keep original placeholder untouched
		lastEnd = match.end;
	}

	if (lastEnd < text.length) {
		const tail = text.slice(lastEnd);
		parts.push(replaceAll(tail, rx, subFn));
	}

	return parts.join("");
}

function replaceAll(
	text: string,
	rx: RegExp,
	subFn: (match: RegExpExecArray) => string
): string {
	const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
	const globalRx = new RegExp(rx.source, flags);
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = globalRx.exec(text)) !== null) {
		// Prevent infinite loop on zero-length matches
		if (match.index === globalRx.lastIndex) {
			globalRx.lastIndex++;
		}
		result += text.slice(lastIndex, match.index);
		result += subFn(match);
		lastIndex = match.index + match[0].length;
	}

	result += text.slice(lastIndex);
	return result;
}

function buildPrefixRegex(prefixes: readonly string[]): RegExp | null {
	const valid = prefixes.filter(Boolean);
	if (valid.length === 0) return null;
	const escaped = valid.map((p) =>
		// Escape regex special chars first, then expand -/_ to[-_] character class
		p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_]/g, "[-_]")
	);
	return new RegExp(`(?<![A-Za-z0-9_-])(?:${escaped.join("|")})[A-Za-z0-9][A-Za-z0-9_-]{7,}(?![A-Za-z0-9_-])`, "g");
}

function buildCustomWordsRegex(customWords: readonly string[] | Record<string, string>): {
	rx: RegExp | null;
	wordMap: Map<string, string>;
} {
	const wordMap = new Map<string, string>();
	if (Array.isArray(customWords)) {
		for (const w of customWords) {
			if (w && typeof w === "string") wordMap.set(w.toLowerCase(), "TERM");
		}
	} else if (customWords && typeof customWords === "object") {
		for (const [w, label] of Object.entries(customWords)) {
			if (w) wordMap.set(w.toLowerCase(), label || "TERM");
		}
	}

	if (wordMap.size === 0) return { rx: null, wordMap };

	// Sort by length descending for longest-match-first
	const sorted = Array.from(wordMap.keys()).sort((a, b) => b.length - a.length);
	const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return {
		rx: new RegExp(`(?:${escaped.join("|")})`, "gi"),
		wordMap,
	};
}

export function maskText(
	text: string,
	sid: string,
	vault: ShieldVault,
	options: ScannerOptions = {}
): string {
	if (!text) return text;

	const enabledRules: Record<string, boolean> = {
		...DEFAULT_BUILTIN_RULES,
		...(options.rules ?? {}),
	};

	let current = text;

	// 1. Secret Prefixes (e.g. sk-, ghp_)
	if (enabledRules["API_KEY"] !== false) {
		const prefixes = options.secretPrefixes ?? DEFAULT_SECRET_PREFIXES;
		const prefixRx = buildPrefixRegex(prefixes);
		if (prefixRx) {
			current = maskExcludingPlaceholders(current, prefixRx, (m) => {
				return vault.remember(sid, m[0], "API_KEY");
			});
		}
	}

	// 2. Custom Words
	if (options.customWords) {
		const { rx: customRx, wordMap } = buildCustomWordsRegex(options.customWords);
		if (customRx) {
			current = maskExcludingPlaceholders(current, customRx, (m) => {
				const word = m[0];
				const label = wordMap.get(word.toLowerCase()) || "TERM";
				return vault.remember(sid, word, label);
			});
		}
	}

	// 3. Custom Regex Rules (User-defined patterns)
	if (options.customRules && options.customRules.length > 0) {
		for (const cr of options.customRules) {
			if (!cr || !cr.pattern) continue;
			try {
				const flags = (cr.flags || "g").includes("g") ? cr.flags || "g" : (cr.flags || "") + "g";
				const rx = new RegExp(cr.pattern, flags);
				current = maskExcludingPlaceholders(current, rx, (m) => {
					return vault.remember(sid, m[0], cr.label || "CUSTOM");
				});
			} catch {
				// Ignore invalid user regex pattern
			}
		}
	}

	// Track exempted connection string ranges to avoid EMAIL collision
	const exemptConnSpans: Array<{ start: number; end: number }> = [];

	// 4. Built-in Rules (or dynamically synced rules from Maskit)
	const effectiveRules = loadSyncedRules() ?? BUILTIN_RULES;
	for (const rule of effectiveRules) {
		if (enabledRules[rule.label] === false) continue;
		if (!ruleMayHit(current, rule)) continue;

		const subFn = (m: RegExpExecArray): string => {
			const orig = rule.captureGroup === 0 ? m[0] : m[rule.captureGroup];
			if (!orig) return m[0];

			// Specific validators
			if (rule.label === "CARD" && !isCardValid(orig)) return m[0];
			if (rule.label === "IDCARD" && !isIdCardValid(orig)) return m[0];
			if (rule.label === "PHONE" && !isPhoneValid(orig)) return m[0];
			if (rule.label === "IBAN" && !isIbanValid(orig)) return m[0];
			if (rule.label === "JWT" && !isJwtValid(orig)) return m[0];
			if (rule.label === "CONNSTR") {
				if (!isConnStrPasswordValid(orig)) {
					exemptConnSpans.push({ start: m.index, end: m.index + m[0].length });
					return m[0];
				}
				const token = vault.remember(sid, orig, rule.label);
				// Replace only the captured password group inside the connection string
				const full = m[0];
				const matchPos = full.indexOf(":" + orig + "@");
				if (matchPos !== -1) {
					return full.slice(0, matchPos + 1) + token + full.slice(matchPos + 1 + orig.length);
				}
				return full.replace(orig, token);
			}
			if (rule.label === "EMAIL") {
				if (!isEmailValid(orig)) return m[0];
				// Check overlap with exempted connection strings
				const start = m.index;
				const end = m.index + m[0].length;
				for (const span of exemptConnSpans) {
					if (start < span.end && end > span.start) {
						return m[0];
					}
				}
			}

			const token = vault.remember(sid, orig, rule.label);

			if (rule.captureGroup > 0) {
				// Replace captured group within the match
				const full = m[0];
				const idx = full.indexOf(orig);
				if (idx !== -1) {
					return full.slice(0, idx) + token + full.slice(idx + orig.length);
				}
			}

			return token;
		};

		current = maskExcludingPlaceholders(current, rule.regex, subFn);
	}

	return current;
}
