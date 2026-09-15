/**
 * Data Maskit - Privacy Shield Engine: SSE Streaming Restoration
 * Handles typewriter-smooth restoration of placeholders, tail-buffering across chunks,
 * reasoning/thinking streams, and tool arguments.
 */

import { Transform } from "node:stream";
import {
	ESCAPED_PLACEHOLDER_RX,
	LOOSE_PLACEHOLDER_RX,
	PARTIAL_MAX,
	PARTIAL_RX,
	PLACEHOLDER_RX,
	ShieldVault,
} from "./vault.ts";

/**
 * Escapes characters for insertion into a JSON string if escape is true.
 */
function formatOriginal(orig: string, escape: boolean): string {
	if (!escape) return orig;
	// JSON encode and strip surrounding quotes
	return JSON.stringify(orig).slice(1, -1);
}

/**
 * Restores masked placeholders in incoming stream fragments.
 * Handles split placeholders across chunks using a channel tail buffer.
 */
export function restoreText(
	text: string,
	sid: string,
	vault: ShieldVault,
	channel = "default",
	escape = false,
	final = false
): string {
	if (typeof text !== "string") return text;
	const session = vault.getOrCreateSession(sid);

	const prevPending = session.pending.get(channel) || "";
	const buf = prevPending + text;

	let confirmed = "";
	if (final) {
		session.pending.delete(channel);
		confirmed = buf;
	} else {
		const m = PARTIAL_RX.exec(buf);
		if (m && m.index + m[0].length === buf.length && m[0].length <= PARTIAL_MAX) {
			confirmed = buf.slice(0, m.index);
			session.pending.set(channel, m[0]);
		} else {
			confirmed = buf;
			session.pending.delete(channel);
		}
	}

	if (!confirmed) return "";

	// Pass 1: Strict match {{LABEL_suffix}}
	let out = confirmed.replace(new RegExp(PLACEHOLDER_RX.source, "g"), (token) => {
		const { original, viaSuffix } = vault.lookup(token, sid);
		if (original !== null) {
			session.restoredTokens.add(token);
			if (viaSuffix) session.degraded++;
			return formatOriginal(original, escape);
		}
		session.unresolved++;
		return token;
	});

	// Pass 2: Escaped forms like \{\{LABEL_suffix\}\}
	if (out.includes("_")) {
		out = out.replace(
			new RegExp(ESCAPED_PLACEHOLDER_RX.source, "gi"),
			(whole, label, suffix) => {
				const candidate = `{{${label.toUpperCase()}_${suffix.toLowerCase()}}}`;
				const { original, viaSuffix } = vault.lookup(candidate, sid);
				if (original !== null) {
					session.restoredTokens.add(candidate);
					if (viaSuffix) session.degraded++;
					return formatOriginal(original, escape);
				}
				return whole;
			}
		);
	}

	// Pass 3: Loose placeholders (missing one or both braces)
	if (out.includes("_")) {
		out = out.replace(new RegExp(LOOSE_PLACEHOLDER_RX.source, "g"), (whole, inner) => {
			const candidate = `{{${inner}}}`;
			const { original, viaSuffix } = vault.lookup(candidate, sid);
			if (original !== null) {
				session.degraded++;
				session.restoredTokens.add(candidate);
				return formatOriginal(original, escape);
			}
			return whole;
		});
	}

	return out;
}

/**
 * Recursively restores any string values in an object/array if they contain '_' (placeholders).
 */
function restoreObjectValues(obj: unknown, sid: string, vault: ShieldVault): unknown {
	if (typeof obj === "string") {
		return obj.includes("_") ? restoreText(obj, sid, vault, "obj", false, true) : obj;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => restoreObjectValues(item, sid, vault));
	}
	if (obj && typeof obj === "object") {
		const res: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			// Skip structural ID and metadata fields
			if (["id", "type", "role", "model", "status", "object", "sequence_number", "item_id"].includes(k)) {
				res[k] = v;
			} else {
				res[k] = restoreObjectValues(v, sid, vault);
			}
		}
		return res;
	}
	return obj;
}

/**
 * Restores a single parsed SSE event payload.
 */
function restoreSSEData(
	dataStr: string,
	sid: string,
	vault: ShieldVault
): string {
	const trimmed = dataStr.trim();
	if (trimmed === "[DONE]") {
		// Flush all pending channels for this session
		const session = vault.getOrCreateSession(sid);
		session.pending.clear();
		return dataStr;
	}

	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;

		// 1. OpenAI format: choices[].delta
		if (Array.isArray(parsed.choices)) {
			parsed.choices = parsed.choices.map((choice: any, cIdx: number) => {
				if (!choice || typeof choice !== "object" || !choice.delta) return choice;
				const delta = { ...choice.delta };

				if (typeof delta.content === "string") {
					delta.content = restoreText(delta.content, sid, vault, `c${cIdx}.content`, false, false);
				}
				if (typeof delta.reasoning_content === "string") {
					delta.reasoning_content = restoreText(
						delta.reasoning_content,
						sid,
						vault,
						`c${cIdx}.reason`,
						false,
						false
					);
				}
				if (typeof delta.reasoning === "string") {
					delta.reasoning = restoreText(delta.reasoning, sid, vault, `c${cIdx}.reason`, false, false);
				}

				if (Array.isArray(delta.tool_calls)) {
					delta.tool_calls = delta.tool_calls.map((tc: any, tIdx: number) => {
						if (tc && tc.function && typeof tc.function.arguments === "string") {
							return {
								...tc,
								function: {
									...tc.function,
									arguments: restoreText(
										tc.function.arguments,
										sid,
										vault,
										`c${cIdx}.tc${tc.index ?? tIdx}`,
										true, // escape JSON string inside arguments
										false
									),
								},
							};
						}
						return tc;
					});
				}

				return { ...choice, delta };
			});
			return JSON.stringify(parsed);
		}

		// 2. Anthropic format
		// event: content_block_delta
		if (parsed.type === "content_block_delta" && parsed.delta && typeof parsed.delta === "object") {
			const delta = { ...(parsed.delta as any) };
			if (typeof delta.text === "string") {
				delta.text = restoreText(delta.text, sid, vault, "anthropic.text", false, false);
			}
			if (typeof delta.thinking === "string") {
				delta.thinking = restoreText(delta.thinking, sid, vault, "anthropic.thinking", false, false);
			}
			if (typeof delta.partial_json === "string") {
				delta.partial_json = restoreText(delta.partial_json, sid, vault, "anthropic.json", true, false);
			}
			return JSON.stringify({ ...parsed, delta });
		}

		// 3. OpenAI Responses format (response.output_text.delta, response.text.delta, etc.)
		if (typeof parsed.type === "string" && parsed.type.startsWith("response.") && typeof parsed.delta === "string") {
			parsed.delta = restoreText(parsed.delta, sid, vault, "responses.delta", false, false);
			return JSON.stringify(parsed);
		}

		// 4. OpenAI Responses completed/done events or arbitrary structured SSE objects
		if (typeof parsed.type === "string" && parsed.type.startsWith("response.")) {
			const restored = restoreObjectValues(parsed, sid, vault);
			return JSON.stringify(restored);
		}

		// 5. Fallback: if there is a top-level text or response
		if (typeof parsed.text === "string") {
			parsed.text = restoreText(parsed.text, sid, vault, "top.text", false, false);
			return JSON.stringify(parsed);
		}

		return dataStr;
	} catch {
		// Not JSON, return as-is
		return dataStr;
	}
}

/**
 * Node.js Stream Transform that parses line-by-line SSE events,
 * unmasks placeholders, and outputs reconstituted SSE data.
 */
export class SSEStreamRestoreTransform extends Transform {
	private lineBuffer = "";
	private readonly sid: string;
	private readonly vault: ShieldVault;

	constructor(sid: string, vault: ShieldVault) {
		super({ decodeStrings: false, encoding: "utf-8" });
		this.sid = sid;
		this.vault = vault;
	}

	override _transform(chunk: string | Buffer, _encoding: BufferEncoding, callback: () => void): void {
		const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
		this.lineBuffer += str;

		const lines = this.lineBuffer.split("\n");
		// Keep trailing incomplete line in buffer
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			this.processLine(line);
		}
		callback();
	}

	override _flush(callback: () => void): void {
		if (this.lineBuffer) {
			this.processLine(this.lineBuffer);
			this.lineBuffer = "";
		}

		// Flush any remaining pending tail tokens
		const session = this.vault.getOrCreateSession(this.sid);
		for (const [channel, pending] of session.pending.entries()) {
			if (pending) {
				const flushed = restoreText("", this.sid, this.vault, channel, false, true);
				if (flushed) {
					this.push(`data: ${JSON.stringify({ choices: [{ delta: { content: flushed } }] })}\n\n`);
				}
			}
		}
		session.pending.clear();
		callback();
	}

	private processLine(rawLine: string): void {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

		if (line.startsWith("data:")) {
			const prefix = line.startsWith("data: ") ? "data: " : "data:";
			const payload = line.slice(prefix.length);
			const restored = restoreSSEData(payload, this.sid, this.vault);
			this.push(`${prefix}${restored}\n`);
		} else {
			this.push(`${line}\n`);
		}
	}
}
