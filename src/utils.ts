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
