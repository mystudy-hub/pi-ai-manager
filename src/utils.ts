import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getProviders } from "@earendil-works/pi-ai/compat";

/** Small, dependency-free helpers used by ai-gateway commands. */

export function validateName(name: string): string | undefined {
	if (!name) return "Provider name cannot be empty.";
	if (/[\s/\\]/.test(name)) return "Provider name must not contain spaces or slashes.";
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
	if (!Number.isSafeInteger(tokens) || tokens <= 0) return undefined;
	return tokens;
}

export function matchesGlob(value: string, pattern: string): boolean {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	try {
		return new RegExp(`^${expression}$`, "i").test(value);
	} catch {
		return false;
	}
}
