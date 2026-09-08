import { isIP } from "node:net";
/** Validation at the boundary between gateway data, credentials and the terminal. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const MAX_MODEL_ID_LENGTH = 512;
export const MAX_DISCOVERED_MODELS = 10_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_CONTEXT_TOKENS = 10_000_000;

export function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_ID_LENGTH &&
		value === value.trim() && !CONTROL_CHARACTERS.test(value) && !RESERVED_KEYS.has(value);
}

export function isSafeProviderName(value: unknown): value is string {
	return isSafeIdentifier(value) && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(value);
}

export function safeDisplay(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
}

export function safeError(error: unknown, secrets: readonly string[] = []): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const secret of secrets) {
		if (secret) message = message.split(secret).join("***");
	}
	return safeDisplay(message)
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer ***")
		.replace(/\bsk-[A-Za-z0-9._-]+/g, "sk-***")
		.replace(/\s+/g, " ").slice(0, 300);
}

export function canonicalBaseUrl(raw: string, allowInsecureHttp = false): string {
	try {
		if (CONTROL_CHARACTERS.test(raw)) return "";
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		if (url.username || url.password || url.search || url.hash) return "";
		const local = url.hostname === "localhost" || url.hostname === "[::1]" || (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
		if (url.protocol === "http:" && !local && !allowInsecureHttp) return "";
		return url.toString().replace(/\/+$/, "").replace(/\/v1$/i, "");
	} catch {
		return "";
	}
}

export function isTokenLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_CONTEXT_TOKENS;
}

export function isEnvName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Pi interpolates $NAME and executes leading !command, even for extension credentials. */
export function literalCredential(value: string): string {
	const escaped = value.replace(/\$/g, "$$$$");
	return escaped.startsWith("!") ? "$!" + escaped.slice(1) : escaped;
}
