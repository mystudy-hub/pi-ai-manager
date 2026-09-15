/**
 * Data Maskit - Privacy Shield Engine: Request Payload Transformer
 * Safely traverses and masks request bodies for OpenAI, Anthropic, and other LLM APIs.
 */

import { maskText, type ScannerOptions } from "./scanner.ts";
import { ShieldVault } from "./vault.ts";

export interface TransformerOptions extends ScannerOptions {
	maskToolArguments?: boolean;
}

/**
 * Recursively masks any string values inside an object/array,
 * skipping protocol and structural keys (e.g. "role", "model", "id", "type").
 */
function maskGenericValue(
	val: unknown,
	sid: string,
	vault: ShieldVault,
	options: TransformerOptions
): unknown {
	if (typeof val === "string") {
		return maskText(val, sid, vault, options);
	}
	if (Array.isArray(val)) {
		return val.map((item) => maskGenericValue(item, sid, vault, options));
	}
	if (val !== null && typeof val === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val)) {
			// Skip structural metadata keys
			if (["role", "type", "id", "name", "tool_call_id"].includes(k)) {
				result[k] = v;
			} else {
				result[k] = maskGenericValue(v, sid, vault, options);
			}
		}
		return result;
	}
	return val;
}

/**
 * Safely masks tool arguments (which is a JSON string in OpenAI format)
 * by parsing to object, masking values, and serializing back.
 */
function maskJsonArgumentString(
	argStr: string,
	sid: string,
	vault: ShieldVault,
	options: TransformerOptions
): string {
	if (!argStr || typeof argStr !== "string") return argStr;
	try {
		const parsed = JSON.parse(argStr);
		const masked = maskGenericValue(parsed, sid, vault, options);
		return JSON.stringify(masked);
	} catch {
		// If it is not valid JSON, fallback to text masking
		return maskText(argStr, sid, vault, options);
	}
}

/**
 * Transforms an OpenAI format request body:
 * - messages[].content (string or array of blocks)
 * - messages[].tool_calls[].function.arguments (JSON string)
 * - system (if top level)
 */
function transformOpenAIBody(
	body: Record<string, unknown>,
	sid: string,
	vault: ShieldVault,
	options: TransformerOptions
): Record<string, unknown> {
	const output = { ...body };

	// Top-level system or prompt or instructions
	if (typeof output.system === "string") {
		output.system = maskText(output.system, sid, vault, options);
	}
	if (typeof output.instructions === "string") {
		output.instructions = maskText(output.instructions, sid, vault, options);
	}
	if (typeof output.input === "string") {
		output.input = maskText(output.input, sid, vault, options);
	} else if (Array.isArray(output.input)) {
		output.input = maskGenericValue(output.input, sid, vault, options);
	}
	if (typeof output.prompt === "string") {
		output.prompt = maskText(output.prompt, sid, vault, options);
	} else if (Array.isArray(output.prompt)) {
		output.prompt = output.prompt.map((p) =>
			typeof p === "string" ? maskText(p, sid, vault, options) : p
		);
	}

	// Messages array
	if (Array.isArray(output.messages)) {
		output.messages = output.messages.map((msg) => {
			if (!msg || typeof msg !== "object") return msg;
			const transformedMsg = { ...msg };

			// 1. Message content
			if (typeof transformedMsg.content === "string") {
				transformedMsg.content = maskText(transformedMsg.content, sid, vault, options);
			} else if (Array.isArray(transformedMsg.content)) {
				transformedMsg.content = transformedMsg.content.map((part: any) => {
					if (part && typeof part === "object") {
						if (part.type === "text" && typeof part.text === "string") {
							return { ...part, text: maskText(part.text, sid, vault, options) };
						}
						// If content part has text-like fields
						if (typeof part.content === "string") {
							return { ...part, content: maskText(part.content, sid, vault, options) };
						}
					}
					return part;
				});
			}

			// 2. OpenAI Tool Calls
			if (options.maskToolArguments !== false && Array.isArray(transformedMsg.tool_calls)) {
				transformedMsg.tool_calls = transformedMsg.tool_calls.map((tc: any) => {
					if (tc && typeof tc === "object" && tc.function && typeof tc.function.arguments === "string") {
						return {
							...tc,
							function: {
								...tc.function,
								arguments: maskJsonArgumentString(tc.function.arguments, sid, vault, options),
							},
						};
					}
					return tc;
				});
			}

			return transformedMsg;
		});
	}

	return output;
}

/**
 * Transforms an Anthropic format request body:
 * - system: string | array of text blocks
 * - messages[].content: string | array of blocks (text, tool_use, tool_result)
 */
function transformAnthropicBody(
	body: Record<string, unknown>,
	sid: string,
	vault: ShieldVault,
	options: TransformerOptions
): Record<string, unknown> {
	const output = { ...body };

	// System prompt
	if (typeof output.system === "string") {
		output.system = maskText(output.system, sid, vault, options);
	} else if (Array.isArray(output.system)) {
		output.system = output.system.map((block) => {
			if (block && typeof block === "object" && typeof block.text === "string") {
				return { ...block, text: maskText(block.text, sid, vault, options) };
			}
			return block;
		});
	}

	// Messages
	if (Array.isArray(output.messages)) {
		output.messages = output.messages.map((msg) => {
			if (!msg || typeof msg !== "object") return msg;
			const transformedMsg = { ...msg };

			if (typeof transformedMsg.content === "string") {
				transformedMsg.content = maskText(transformedMsg.content, sid, vault, options);
			} else if (Array.isArray(transformedMsg.content)) {
				transformedMsg.content = transformedMsg.content.map((block: any) => {
					if (!block || typeof block !== "object") return block;
					const b = { ...block };

					// Anthropic text block
					if (b.type === "text" && typeof b.text === "string") {
						b.text = maskText(b.text, sid, vault, options);
					}
					// Anthropic tool_result block
					else if (b.type === "tool_result") {
						if (typeof b.content === "string") {
							b.content = maskText(b.content, sid, vault, options);
						} else if (Array.isArray(b.content)) {
							b.content = b.content.map((inner: any) => {
								if (inner && typeof inner === "object" && typeof inner.text === "string") {
									return { ...inner, text: maskText(inner.text, sid, vault, options) };
								}
								return inner;
							});
						}
					}
					// Anthropic tool_use block
					else if (b.type === "tool_use" && options.maskToolArguments !== false && b.input && typeof b.input === "object") {
						b.input = maskGenericValue(b.input, sid, vault, options);
					}

					return b;
				});
			}

			return transformedMsg;
		});
	}

	return output;
}

/**
 * Universal request body transformer: detects OpenAI or Anthropic format,
 * runs masking, and returns the modified JSON object.
 */
export function transformRequestBody(
	body: unknown,
	sid: string,
	vault: ShieldVault,
	options: TransformerOptions = {}
): unknown {
	if (!body || typeof body !== "object") return body;

	const record = body as Record<string, unknown>;

	// Anthropic format typically has "messages" and might have "system" or anthropic version
	// OpenAI format has "messages" or "prompt"
	if (Array.isArray(record.messages)) {
		// Check if messages have Anthropic block structure or OpenAI format
		const firstMsg = record.messages[0];
		const isAnthropicStyle =
			firstMsg &&
			typeof firstMsg === "object" &&
			Array.isArray(firstMsg.content) &&
			firstMsg.content.some((b: any) => b && (b.type === "tool_use" || b.type === "tool_result"));

		if (isAnthropicStyle || (record.system && Array.isArray(record.system))) {
			return transformAnthropicBody(record, sid, vault, options);
		}
		// Default to OpenAI transformer (which also gracefully handles text messages)
		return transformOpenAIBody(record, sid, vault, options);
	}

	if (record.prompt || record.input !== undefined || record.instructions !== undefined) {
		return transformOpenAIBody(record, sid, vault, options);
	}

	// Fallback to generic recursive masking
	return maskGenericValue(record, sid, vault, options);
}
