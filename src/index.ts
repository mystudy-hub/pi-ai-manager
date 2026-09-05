/**
 * ai-gateway v3 — AI Gateway management extension for Pi Coding Agent
 *
 * All management lives in the interactive /ai-manager TUI:
 * left pane = providers (n adds, D deletes), right pane = models of the
 * selected provider (Space toggles, t/T/A test, r/R refresh, p cycles the
 * model's API, e/x pattern, a auto-select, d dedup, c compare, / filter,
 * s/q sort & quality).
 * Adding a provider collects name / base URL / API key in the TUI and
 * auto-detects the API family from /v1/models endpoint types.
 *
 * At startup every configured provider is registered with pi so its models
 * are usable without opening the manager.
 */

// TLS workaround for relay gateways with broken post-quantum handshakes
import tls from "node:tls";
tls.DEFAULT_ECDH_CURVE = "X25519";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { registerProviderFor } from "./provider.ts";
import { registerCommands } from "./commands.ts";

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export default function aiGateway(pi: ExtensionAPI): void {
	const config = readConfig();

	// Register all configured providers
	for (const [name, entry] of Object.entries(config.providers)) {
		registerProviderFor(pi, name, entry);
	}

	const names = Object.keys(config.providers);
	if (names.length === 0) {
		console.log("ai-gateway v3: no gateways configured. Run /ai-manager to add one.");
	} else {
		console.log(`ai-gateway v3: loaded ${names.length} gateway(s): ${names.join(", ")}`);
	}

	registerCommands(pi);
}
