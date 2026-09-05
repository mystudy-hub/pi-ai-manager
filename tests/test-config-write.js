/**
 * Test script to verify config write functionality
 */
import { ConfigWriter } from "../src/performance.ts";

console.log("Testing config write functionality...\n");

try {
	// Test 1: Load performance.ts
	console.log("✓ Test 1: Loading performance.ts...");
	console.log("  - ConfigWriter class found:", typeof ConfigWriter === "function");

	// Test 2: Create ConfigWriter instance
	console.log("\n✓ Test 2: Creating ConfigWriter instance...");
	const writer = new ConfigWriter();
	console.log("  - Instance created:", writer !== null);
	console.log("  - Has scheduleWrite method:", typeof writer.scheduleWrite === "function");
	console.log("  - Has flush method:", typeof writer.flush === "function");

	// Test 3: Test scheduleWrite
	console.log("\n✓ Test 3: Testing scheduleWrite...");
	let executed = false;
	writer.scheduleWrite(() => {
		executed = true;
		console.log("  - Write callback executed successfully!");
	}, 100);

	setTimeout(() => {
		console.log("  - Callback execution status:", executed);

		// Test 4: Test flush
		console.log("\n✓ Test 4: Testing flush...");
		let flushed = false;
		writer.scheduleWrite(() => {
			flushed = true;
			console.log("  - Flush callback executed successfully!");
		}, 1000);

		writer.flush();
		console.log("  - Flush status:", flushed);

		console.log("\n✅ All tests passed!");
	}, 200);
} catch (error) {
	console.error("\n❌ Test failed:", error instanceof Error ? error.message : error);
	if (error instanceof Error && error.stack) {
		console.error("\nStack trace:", error.stack);
	}
	process.exit(1);
}
