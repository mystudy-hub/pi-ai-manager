// Test suite for v3.1 improvements

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { getConfigRecoveryInstance } from "./config-v2.ts";
import { OperationHistory } from "./tui-state.ts";
import { ConfigWriter, TTLCache } from "./performance.ts";

let failed = false;

function fail(msg: string, err?: unknown): void {
	failed = true;
	console.error(`✗ ${msg}`, err ?? "");
	process.exitCode = 1;
}

function pass(msg: string): void {
	console.log(`✓ ${msg}`);
}

async function runTests(): Promise<void> {
	// Test 1: Config Recovery
	console.log("Test 1: Config Recovery System");
	const testPath = join(tmpdir(), `test-ai-gateway-config-${Date.now()}.json`);
	try {
		writeFileSync(testPath, JSON.stringify({ version: 1, providers: {}, settings: {} }));
		const recovery = getConfigRecoveryInstance();

		// Simulate backup
		const backup = recovery.backup(testPath);
		if (!backup) {
			fail("Backup returned undefined");
		} else {
			pass("Backup created successfully");
		}

		// List backups
		const backups = recovery.listBackups();
		if (backups.length === 0) {
			fail("Expected at least one backup");
		} else {
			pass(`Found ${backups.length} backup(s)`);
			pass("Config recovery test passed\n");
		}
	} catch (error) {
		fail("Config recovery test failed:", error);
	} finally {
		try { unlinkSync(testPath); } catch {}
	}

	// Test 2: Operation History
	console.log("Test 2: Operation History (Undo/Redo)");
	try {
		const history = new OperationHistory(10);

		// Create test operations
		const op1 = {
			type: "toggle-model" as const,
			timestamp: Date.now(),
			gateway: "test-gateway",
			description: "Toggle model A",
			previousState: ["model-1"],
			newState: ["model-1", "model-2"],
		};

		const op2 = {
			type: "enable-pattern" as const,
			timestamp: Date.now(),
			gateway: "test-gateway",
			description: "Enable gpt-*",
			previousState: ["model-1", "model-2"],
			newState: ["model-1", "model-2", "model-3"],
		};

		history.push(op1);
		history.push(op2);

		if (!history.canUndo()) {
			fail("Expected canUndo() to be true");
		} else {
			pass(`Pushed 2 operations, can undo: ${history.canUndo()}`);
		}

		// Undo
		const undone = history.undo();
		if (undone?.description !== "Enable gpt-*") {
			fail(`Expected undone description 'Enable gpt-*', got '${undone?.description}'`);
		} else {
			pass(`Undone: ${undone?.description}`);
			pass(`Can undo: ${history.canUndo()}, can redo: ${history.canRedo()}`);
		}

		// Redo
		const redone = history.redo();
		if (redone?.description !== "Enable gpt-*") {
			fail(`Expected redone description 'Enable gpt-*', got '${redone?.description}'`);
		} else {
			pass(`Redone: ${redone?.description}`);
			pass("Operation history test passed\n");
		}
	} catch (error) {
		fail("Operation history test failed:", error);
	}

	// Test 3: Config Writer (Debouncing)
	console.log("Test 3: Config Writer (Debouncing)");
	try {
		let writeCount = 0;
		const mockWrite = () => {
			writeCount++;
		};

		const writer = new ConfigWriter(100, mockWrite);

		// Trigger multiple writes quickly
		for (let i = 0; i < 10; i++) {
			writer.write({ providers: {} });
		}

		pass(`Triggered 10 writes, actual writes before debounce: ${writeCount}`);

		// Wait for debounce
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				pass(`Writes after debounce (should be 1): ${writeCount}`);
				if (writeCount === 1) {
					pass("Config writer test passed\n");
				} else {
					fail(`Expected 1 write, got ${writeCount}\n`);
				}
				resolve();
			}, 200);
		});
	} catch (error) {
		fail("Config writer test failed:", error);
	}

	// Test 4: TTL Cache
	console.log("Test 4: TTL Cache");
	try {
		const cache = new TTLCache<string, string>(500); // 500ms TTL

		// Set value
		cache.set("key1", "value1");
		pass(`Set key1, got: ${cache.get("key1")}`);

		// Get non-existent key
		const missing = cache.get("key2");
		if (missing !== undefined) {
			fail("Expected undefined for missing key");
		} else {
			pass("Get missing key: undefined (correct)");
		}

		// Test expiration
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				const expired = cache.get("key1");
				if (expired !== undefined) {
					fail("TTL cache test failed: value should have expired");
				} else {
					pass("Get after TTL: expired (correct)");
					pass("TTL cache test passed\n");
				}
				resolve();
			}, 600);
		});
	} catch (error) {
		fail("TTL cache test failed:", error);
	}

	if (failed) {
		console.error("❌ Some tests failed!");
		process.exitCode = 1;
	} else {
		console.log("✅ All improvement tests passed successfully!\n");
	}
}

runTests().catch((err) => {
	console.error("Fatal error running tests:", err);
	process.exit(1);
});
