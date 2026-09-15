/**
 * End-to-end integration test for ShieldProxyServer:
 * - Mock upstream server
 * - Masking on outgoing POST
 * - Passthrough on incoming GET /v1/models
 * - Streaming restoration on incoming SSE
 */

import http from "node:http";
import assert from "node:assert/strict";
import { ShieldProxyServer } from "../src/shield/proxy.ts";

console.log("Running Privacy Shield Proxy E2E Test...");

async function runTest() {
	let receivedUpstreamBody = "";
	const rawSecret = "sk-proj-TopSecretAgentKey998877";

	// 1. Create Mock Upstream Server
	const mockUpstream = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "mock-model-1" }] }));
			return;
		}

		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				receivedUpstreamBody = body;
				console.log("  [Upstream Received Body]:", body);

				// Respond with streaming SSE containing the placeholder received
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});

				const parsed = JSON.parse(body);
				const userContent = parsed.messages[0].content; // This should be masked!

				res.write(`data: {"choices":[{"delta":{"content":"Echoing back: "}}]}\n\n`);
				res.write(`data: {"choices":[{"delta":{"content":"${userContent}"}}]}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
	const upstreamPort = mockUpstream.address().port;
	console.log(`  Mock upstream listening on port ${upstreamPort}`);

	// 2. Start ShieldProxyServer
	const proxy = new ShieldProxyServer();
	const proxyPort = await proxy.start(0);
	console.log(`  ShieldProxyServer listening on port ${proxyPort}`);

	proxy.registerUpstream({
		name: "test-gateway",
		targetBaseUrl: `http://127.0.0.1:${upstreamPort}`,
		options: {},
	});

	// 3. Test GET /v1/models transparent passthrough
	console.log("Test A: GET /v1/models transparent passthrough");
	const modelsUrl = `http://127.0.0.1:${proxyPort}/_shield/test-gateway/v1/models`;
	const modelsRes = await fetch(modelsUrl);
	assert.strictEqual(modelsRes.status, 200);
	const modelsJson = await modelsRes.json();
	assert.strictEqual(modelsJson.data[0].id, "mock-model-1", "Models discovery must pass through untouched");
	console.log("  ✓ Models discovery passthrough verified");

	// 4. Test POST /v1/chat/completions masking & streaming restoration
	console.log("Test B: POST /v1/chat/completions masking & SSE restoration");
	const chatUrl = `http://127.0.0.1:${proxyPort}/_shield/test-gateway/v1/chat/completions`;
	const chatRes = await fetch(chatUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "mock-model-1",
			messages: [{ role: "user", content: `My sensitive token is ${rawSecret}` }],
		}),
	});

	assert.strictEqual(chatRes.status, 200);
	const chatResponseText = await chatRes.text();
	console.log("  [Client Received Restored SSE Stream]:\n" + chatResponseText);

	// Verify upstream NEVER saw the raw secret
	assert.ok(!receivedUpstreamBody.includes(rawSecret), "Upstream must NEVER receive the raw secret!");
	assert.ok(receivedUpstreamBody.includes("{{APIKEY_"), "Upstream must receive the placeholder");

	// Verify client received the RESTORED original secret
	assert.ok(chatResponseText.includes(rawSecret), "Client must receive restored raw secret in SSE stream!");
	console.log("  ✓ Upstream privacy verified (masked) & client response verified (restored)");

	// Clean up
	await proxy.stop();
	await new Promise((resolve) => mockUpstream.close(resolve));
	console.log("🎉 All Proxy E2E Tests Passed Successfully!");
}

runTest().catch((err) => {
	console.error("Proxy Test Failed:", err);
	process.exit(1);
});
