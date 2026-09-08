import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { isSafeProviderName, isTokenLimit } from "./security.ts";

/** Small, dependency-free helpers used by ai-gateway commands. */

export function validateName(name: string): string | undefined {
	if (!name) return "Provider name cannot be empty.";
	if (!isSafeProviderName(name)) return "Use 1–64 letters, digits, dots, underscores or hyphens for the provider name.";
	if ((getProviders() as unknown as string[]).includes(name)) return `"${name}" collides with a built-in pi provider.`;
	return undefined;
}
export function padToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const truncated = truncateToWidth(text, safeWidth, "");
	return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}

/**
 * Parse a manually entered context window. Accepts raw token counts and
 * readable suffixes such as 128k, 256K, 1m, and 1.5M.
 */
export function parseContextWindow(value: string): number | undefined {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
	const tokens = amount * multiplier;
	if (!isTokenLimit(tokens)) return undefined;
	return tokens;
}

export function matchesGlob(value: string, pattern: string): boolean {
	// Bounded dynamic programming avoids exponential regex backtracking for repeated *.
	if (pattern.length > 512 || value.length > 512) return false;
	const text = [...value.toLowerCase()];
	let previous = new Array<boolean>(text.length + 1).fill(false);
	previous[0] = true;
	for (const char of pattern.toLowerCase()) {
		const next = new Array<boolean>(text.length + 1).fill(false);
		next[0] = char === "*" && previous[0];
		for (let i = 1; i <= text.length; i++) {
			next[i] = char === "*" ? previous[i] || next[i - 1] : previous[i - 1] && (char === "?" || char === text[i - 1]);
		}
		previous = next;
	}
	return previous[text.length];
}
