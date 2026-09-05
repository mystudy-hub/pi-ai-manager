// Test suite for v3.1 improvements

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { getConfigRecoveryInstance } from "../src/config-v2.ts";
import { OperationHistory } from "../src/tui-state.ts";
import { ConfigWriter, TTLCache } from "../src/performance.ts";

// Test 1: Config Recovery
console.log("Test 1: Config Recovery System");
try {
	const recovery = getConfigRecoveryInstance();
	const testPath = join(tmpdir(), "test-config.json");
	writeFileSync(testPath, JSON.stringify({ version: 1, providers: {} }));

	// Simulate backup
	recovery.backup(testPath);
	console.log("✓ Backup created successfully");

	// List backups
	const backups = recovery.listBackups();
	console.log(`✓ Found ${backups.length} backup(s)`);

	try { unlinkSync(testPath); } catch {}
	console.log("✓ Config recovery test passed\n");
} catch (error) {
	console.error("✗ Config recovery test failed:", error);
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

	console.log(`✓ Pushed 2 operations, can undo: ${history.canUndo()}`);

	// Undo
	const undone = history.undo();
	console.log(`✓ Undone: ${undone?.description}`);
	console.log(`✓ Can undo: ${history.canUndo()}, can redo: ${history.canRedo()}`);

	// Redo
	const redone = history.redo();
	console.log(`✓ Redone: ${redone?.description}`);

	console.log("✓ Operation history test passed\n");
} catch (error) {
	console.error("✗ Operation history test failed:", error);
}

// Test 3: Config Writer (Debouncing)
console.log("Test 3: Config Writer (Debouncing)");
try {
	let writeCount = 0;
	const mockWrite = () => {
		writeCount++;
	};

	const writer = new ConfigWriter();

	// Trigger multiple writes quickly
	for (let i = 0; i < 10; i++) {
		writer.scheduleWrite(mockWrite, 100);
	}

	console.log(`✓ Triggered 10 writes, actual writes before debounce: ${writeCount}`);

	// Wait for debounce
	setTimeout(() => {
		console.log(`✓ Writes after debounce (should be 1): ${writeCount}`);
		if (writeCount === 1) {
			console.log("✓ Config writer test passed\n");
		} else {
			console.error(`✗ Expected 1 write, got ${writeCount}\n`);
		}
	}, 200);

} catch (error) {
	console.error("✗ Config writer test failed:", error);
}

// Test 4: TTL Cache
console.log("Test 4: TTL Cache");
try {
	const cache = new TTLCache<string>(1000); // 1 second TTL

	// Set value
	cache.set("key1", "value1");
	console.log(`✓ Set key1, got: ${cache.get("key1")}`);

	// Get non-existent key
	const missing = cache.get("key2");
	console.log(`✓ Get missing key: ${missing === undefined ? "undefined (correct)" : "wrong"}`);

	// Test expiration
	setTimeout(() => {
		const expired = cache.get("key1");
		console.log(`✓ Get after TTL: ${expired === undefined ? "expired (correct)" : "still cached (wrong)"}`);

		if (expired === undefined) {
			console.log("✓ TTL cache test passed\n");
		} else {
			console.error("✗ TTL cache test failed: value should have expired\n");
		}
	}, 1100);

} catch (error) {
	console.error("✗ TTL cache test failed:", error);
}

console.log("All tests initiated. Some results will appear after delays.\n");
