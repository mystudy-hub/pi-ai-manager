// ---------------------------------------------------------------------------
// Unit tests for reasoning detection and configuration
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const cwd = process.cwd();
const reasoningPath = pathToFileURL(join(cwd, "src", "reasoning.ts")).href;
const providerPath = pathToFileURL(join(cwd, "src", "provider.ts")).href;
const utilsPath = pathToFileURL(join(cwd, "src", "utils.ts")).href;

async function runTests() {
	console.log("Running reasoning support tests...\n");

	const { inferReasoningSupport, inferThinkingLevelMap, inferModelCompat } = await import(reasoningPath);
	let buildModelConfigs;
	let parseContextWindow;
	try {
		const mod = await import(providerPath);
		buildModelConfigs = mod.buildModelConfigs;
		const utilsMod = await import(utilsPath);
		parseContextWindow = utilsMod.parseContextWindow;
	} catch {
		let piRequire;
		try {
			piRequire = createRequire(join(process.env.PI_CODING_AGENT_PACKAGE_DIR || "C:/Users/maoju/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent", "package.json"));
		} catch {
			piRequire = require;
		}
		const { createJiti } = piRequire("jiti");
		const tuiPackage = await import(pathToFileURL(piRequire.resolve('@earendil-works/pi-tui')).href);
		const jiti = createJiti(import.meta.url, {
			tryNative: false,
			virtualModules: {
				"@earendil-works/pi-ai/compat": { getProviders: () => ["anthropic", "openai"], getModels: () => [] },
				"@earendil-works/pi-tui": tuiPackage,
			},
		});
		const mod = jiti(join(cwd, "src", "provider.ts"));
		buildModelConfigs = mod.buildModelConfigs;
		const utilsMod = jiti(join(cwd, "src", "utils.ts"));
		parseContextWindow = utilsMod.parseContextWindow;
	}

	// Test 1: DeepSeek reasoning models
	console.log("Test 1: DeepSeek reasoning models");
	assert.strictEqual(inferReasoningSupport("deepseek-v4-flash"), true);
	assert.strictEqual(inferReasoningSupport("DeepSeek-V4-Flash-0731"), true);
	assert.strictEqual(inferReasoningSupport("deepseek-v4-pro"), true);
	assert.strictEqual(inferReasoningSupport("deepseek-r1"), true);
	assert.strictEqual(inferReasoningSupport("deepseek-reasoner"), true);
	assert.strictEqual(inferReasoningSupport("deepseek-chat"), false);
	assert.strictEqual(inferReasoningSupport("deepseek-coder"), false);
	console.log("  ✓ DeepSeek models correctly classified");

	// Test 2: OpenAI reasoning models
	console.log("Test 2: OpenAI reasoning models");
	assert.strictEqual(inferReasoningSupport("gpt-5.6-luna"), true);
	assert.strictEqual(inferReasoningSupport("gpt-5.6-sol"), true);
	assert.strictEqual(inferReasoningSupport("gpt-5.6-terra"), true);
	assert.strictEqual(inferReasoningSupport("gpt-5.4-mini"), true);
	assert.strictEqual(inferReasoningSupport("o1"), true);
	assert.strictEqual(inferReasoningSupport("o3-mini"), true);
	assert.strictEqual(inferReasoningSupport("o4-mini"), true);
	assert.strictEqual(inferReasoningSupport("codex-auto-review"), true);
	assert.strictEqual(inferReasoningSupport("gpt-5-chat-latest"), false);
	assert.strictEqual(inferReasoningSupport("gpt-5.3-chat-latest"), false);
	assert.strictEqual(inferReasoningSupport("gpt-4o"), false);
	console.log("  ✓ OpenAI models correctly classified");

	// Test 3: Qwen and Gemini reasoning models
	console.log("Test 3: Qwen and Gemini reasoning models");
	assert.strictEqual(inferReasoningSupport("qwen3.8-flash"), true);
	assert.strictEqual(inferReasoningSupport("qwq-32b"), true);
	assert.strictEqual(inferReasoningSupport("gemini-3.7-flash-high"), true);
	assert.strictEqual(inferReasoningSupport("gemini-3.8-flash-high"), true);
	assert.strictEqual(inferReasoningSupport("gemini-2.5-flash-thinking"), true);
	assert.strictEqual(inferReasoningSupport("gemini-pro-agent"), false);
	assert.strictEqual(inferReasoningSupport("minimax-m3"), false);
	assert.strictEqual(inferReasoningSupport("glm-5.3-flash"), false);
	console.log("  ✓ Qwen and Gemini models correctly classified");

	// Test 4: ThinkingLevelMap inference
	console.log("Test 4: ThinkingLevelMap inference");
	const dsMap = inferThinkingLevelMap("deepseek-v4-flash");
	assert.strictEqual(dsMap?.high, "high");
	assert.strictEqual(dsMap?.low, "low");
	assert.strictEqual(dsMap?.medium, null);

	const gpt5Map = inferThinkingLevelMap("gpt-5.6-luna");
	assert.strictEqual(gpt5Map?.high, "high");
	assert.strictEqual(gpt5Map?.xhigh, "xhigh");
	assert.strictEqual(gpt5Map?.off, "none");

	const o1Map = inferThinkingLevelMap("o1");
	assert.strictEqual(o1Map?.high, "high");
	assert.strictEqual(o1Map?.off, null);
	console.log("  ✓ ThinkingLevelMap correctly generated");

	// Test 5: Compat inference
	console.log("Test 5: Compat inference");
	const dsCompat = inferModelCompat("deepseek-v4-flash", "openai-completions");
	assert.strictEqual(dsCompat?.thinkingFormat, "deepseek");
	assert.strictEqual(dsCompat?.requiresReasoningContentOnAssistantMessages, true);

	const qwenCompat = inferModelCompat("qwen3.8-flash", "openai-completions");
	assert.strictEqual(qwenCompat?.thinkingFormat, "qwen");
	assert.strictEqual(qwenCompat?.supportsReasoningEffort, true);

	const responsesCompat = inferModelCompat("gpt-5.6-luna", "openai-responses");
	assert.strictEqual(responsesCompat?.supportsOpenAIGrammarTools, true);
	console.log("  ✓ Compat options correctly generated");

	// Test 6: buildModelConfigs passes reasoning, thinkingLevelMap, compat
	console.log("Test 6: buildModelConfigs integration");
	const mockEntry = {
		baseUrl: "https://api.example.com",
		defaultApi: "openai-responses",
		enabledModels: ["deepseek-v4-flash", "minimax-m3"],
		models: {
			"deepseek-v4-flash": { api: "openai-responses" },
			"minimax-m3": { api: "openai-responses", reasoning: false },
		},
	};
	const configs = buildModelConfigs(mockEntry, mockEntry.enabledModels);
	const dsConfig = configs.find(m => m.id === "deepseek-v4-flash");
	const mmConfig = configs.find(m => m.id === "minimax-m3");

	assert.strictEqual(dsConfig?.reasoning, true, "DeepSeek should have reasoning=true");
	assert.ok(dsConfig?.thinkingLevelMap, "DeepSeek should have thinkingLevelMap");
	assert.ok(dsConfig?.compat, "DeepSeek should have compat");
	assert.strictEqual(mmConfig?.reasoning, false, "Minimax should have reasoning=false");
	console.log("  ✓ buildModelConfigs correctly populates reasoning metadata");

	// Test 7: Manual context window parsing
	console.log("Test 7: Manual context window parsing");
	assert.strictEqual(parseContextWindow("128k"), 128000);
	assert.strictEqual(parseContextWindow("256000"), 256000);
	assert.strictEqual(parseContextWindow("1.5M"), 1500000);
	assert.strictEqual(parseContextWindow("0"), undefined);
	assert.strictEqual(parseContextWindow("not-a-size"), undefined);
	console.log("  ✓ Context window values correctly parsed");

	console.log("\n🎉 All reasoning tests passed successfully!");
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
