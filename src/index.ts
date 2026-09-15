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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { registerProviderFor } from "./provider.ts";
import { registerCommands } from "./commands.ts";
import { safeError } from "./security.ts";
import { getGlobalShieldProxy } from "./shield/proxy.ts";

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export default async function aiGateway(pi: ExtensionAPI): Promise<void> {
	registerCommands(pi);
	let config;
	try { config = readConfig(); }
	catch (error) {
		console.error(`ai-gateway: ${safeError(error)}`);
		return;
	}

	// Start Privacy Shield Proxy before registering any providers
	const hasShield = Object.values(config.providers).some(
		(p) => p.shield?.enabled || Object.values(p.models || {}).some((m) => m.shield === true)
	);
	if (hasShield) {
		try {
			const port = await getGlobalShieldProxy().start();
			console.log(`ai-gateway v3: Privacy Shield (Data Maskit) proxy active on 127.0.0.1:${port}`);
		} catch (err) {
			console.error(`ai-gateway v3: Failed to start Privacy Shield proxy: ${safeError(err)}`);
		}
	}

	// One invalid gateway must not stop other gateways or remove the manager command.
	const names: string[] = [];
	for (const [name, entry] of Object.entries(config.providers)) {
		try {
			registerProviderFor(pi, name, entry);
			names.push(name);
		} catch (error) {
			console.error(`ai-gateway: could not register ${name}: ${safeError(error, [entry.apiKey ?? "", entry.apiKeyEnv ? process.env[entry.apiKeyEnv] ?? "" : ""])}`);
		}
	}

	if (typeof pi.on === "function") {
		pi.on("session_shutdown", async () => {
			await getGlobalShieldProxy().stop();
		});
	}

	if (Object.keys(config.providers).length === 0) {
		console.log("ai-gateway v3: no gateways configured. Run /ai-manager to add one.");
	} else {
		console.log(`ai-gateway v3: loaded ${names.length} gateway(s): ${names.join(", ")}`);
	}
}
