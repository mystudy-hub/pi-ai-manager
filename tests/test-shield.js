/**
 * Test suite for Privacy Shield core, transformer, and SSE streaming
 */

import assert from "node:assert/strict";
import { ShieldVault } from "../src/shield/vault.ts";
import { maskText } from "../src/shield/scanner.ts";
import { transformRequestBody } from "../src/shield/transformer.ts";
import { restoreText, SSEStreamRestoreTransform } from "../src/shield/sse.ts";

console.log("Running Privacy Shield Core & Transformer Tests...");

const vault = new ShieldVault();
const sid = "test-session-transformer";

// 1. OpenAI Chat Completions with Tool Calls
console.log("Test 1: OpenAI Chat Body with Tool Calls");
const openAiBody = {
	model: "gpt-4o",
	messages: [
		{ role: "system", content: "You are a helper. Admin token is sk-proj-superAdminToken12345." },
		{ role: "user", content: "Check database at postgres://admin:VerySecretPassword99@10.0.0.5:5432/main" },
		{
			role: "assistant",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "exec_sql",
						arguments: JSON.stringify({
							conn: "postgres://admin:VerySecretPassword99@10.0.0.5:5432/main",
							apiKey: "sk-proj-superAdminToken12345",
							query: "SELECT 1;",
						}),
					},
				},
			],
		},
	],
};

const transformed1 = transformRequestBody(openAiBody, sid, vault, { rules: { IP_INTERNAL: true } });
assert.ok(!transformed1.messages[0].content.includes("sk-proj-superAdminToken12345"), "System key masked");
assert.ok(!transformed1.messages[1].content.includes("VerySecretPassword99"), "User DB password masked");
assert.ok(!transformed1.messages[1].content.includes("10.0.0.5"), "Internal IP masked");

const parsedArgs = JSON.parse(transformed1.messages[2].tool_calls[0].function.arguments);
assert.ok(parsedArgs.query === "SELECT 1;", "Non-sensitive tool arg field intact");
assert.ok(!parsedArgs.apiKey.includes("sk-proj-superAdminToken12345"), "Tool arg key masked");
assert.ok(!parsedArgs.conn.includes("VerySecretPassword99"), "Tool arg DB pass masked");

// 2. Anthropic Format
console.log("Test 2: Anthropic Format with Tool Use");
const anthropicBody = {
	model: "claude-3-5-sonnet",
	system: "Auth key: ghp_11112222333344445555666677778888",
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "Here is phone: 13912345678" },
				{
					type: "tool_result",
					tool_use_id: "tu_1",
					content: "Result: database password is secret_key: MySuperSecretPass888",
				},
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tu_2",
					name: "login",
					input: {
						token: "ghp_11112222333344445555666677778888",
						phone: "13912345678",
					},
				},
			],
		},
	],
};

const transformed2 = transformRequestBody(anthropicBody, sid, vault);
assert.ok(!transformed2.system.includes("ghp_11112222333344445555666677778888"), "Anthropic system masked");
assert.ok(!transformed2.messages[0].content[0].text.includes("13912345678"), "Anthropic user phone masked");
assert.ok(
	!transformed2.messages[0].content[1].content.includes("MySuperSecretPass888"),
	"Anthropic tool_result masked"
);
assert.ok(
	!transformed2.messages[1].content[0].input.token.includes("ghp_11112222333344445555666677778888"),
	"Anthropic tool_use token masked"
);

// 3. SSE Stream Restoration & Split Chunks
console.log("Test 3: SSE Stream Restoration & Split Chunk Tail Buffer");
// Mask a secret and retrieve its token
const secret = "SuperSecret_Database_Token_999";
const token = vault.remember(sid, secret, "API_KEY");
console.log(`  Target secret: ${secret} -> Token: ${token}`);

// Simulate a split across two chunks: e.g. token is {{APIKEY_abcdef}}
// Split at position 7
const chunk1 = `The key is ${token.slice(0, 7)}`;
const chunk2 = `${token.slice(7)}. Done!`;

const restoredChunk1 = restoreText(chunk1, sid, vault, "stream-test", false, false);
console.log("  Chunk 1 input:   ", chunk1);
console.log("  Chunk 1 output:  ", restoredChunk1);
assert.strictEqual(restoredChunk1, "The key is ", "Chunk 1 trailing partial placeholder must be held in buffer");

const restoredChunk2 = restoreText(chunk2, sid, vault, "stream-test", false, true);
console.log("  Chunk 2 input:   ", chunk2);
console.log("  Chunk 2 output:  ", restoredChunk2);
assert.strictEqual(restoredChunk2, `${secret}. Done!`, "Chunk 2 must combine with buffer and restore original text");

// 4. Loose placeholder restoration
console.log("Test 4: Loose Placeholder Restoration (no braces)");
// Model stripped {{ }} -> APIKEY_abcdef
const bareToken = token.replace(/[{}]/g, "");
const looseText = `Using token ${bareToken} in query`;
const restoredLoose = restoreText(looseText, sid, vault, "loose-test", false, true);
console.log("  Loose input:  ", looseText);
console.log("  Loose output: ", restoredLoose);
assert.strictEqual(restoredLoose, `Using token ${secret} in query`, "Loose token must be restored");

// 5. SSEStreamRestoreTransform Node.js Stream
console.log("Test 5: SSEStreamRestoreTransform Pipeline");
const sseTransform = new SSEStreamRestoreTransform(sid, vault);
const sseChunks = [
	'data: {"choices": [{"delta": {"content": "Connecting with token: ' + token.slice(0, 8) + '"}}]}\n\n',
	'data: {"choices": [{"delta": {"content": "' + token.slice(8) + ' and database ok."}}]}\n\n',
	"data: [DONE]\n\n",
];

let outputSSE = "";
sseTransform.on("data", (chunk) => {
	outputSSE += chunk.toString();
});

sseTransform.on("end", () => {
	console.log("  Final Reconstituted SSE:\n" + outputSSE);
	assert.ok(outputSSE.includes(secret), "Full original secret must be present in reconstituted SSE stream");
	assert.ok(!outputSSE.includes(token), "Placeholder must be completely gone from restored stream");
	console.log("🎉 All Tests (Core, Transformer, SSE Stream) Passed Successfully!");
});

for (const c of sseChunks) {
	sseTransform.write(c);
}
sseTransform.end();
