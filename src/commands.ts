import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { RelayManagerTUI } from "./tui.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ai-manager", {
		description: "Interactive AI gateway manager (add/remove providers, models, testing)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("ai-manager requires TUI mode.", "error");
				return;
			}
			const config = readConfig();
			// An empty config is fine: the TUI opens straight into the
			// add-provider form.
			const name = args.trim();
			if (name && !config.providers[name]) {
				ctx.ui.notify(`Gateway "${name}" not found.`, "error");
				return;
			}
			const saved = await new RelayManagerTUI(ctx, pi, config, name || undefined).run();
			ctx.ui.notify(saved ? "Changes saved. Models updated in Pi." : "Cancelled without saving.", "info");
		},
	});
}
