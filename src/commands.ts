import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { RelayManagerTUI } from "./tui.ts";
import { safeError, safeDisplay } from "./security.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ai-manager", {
		description: "Interactive AI gateway manager (add/remove providers, models, testing)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("ai-manager requires TUI mode.", "error");
				return;
			}
			try {
				const config = readConfig();
				// An empty config opens directly into the add-provider form.
				const name = args.trim();
				if (name && !config.providers[name]) {
					ctx.ui.notify(`Gateway "${safeDisplay(name)}" not found.`, "error");
					return;
				}
				const saved = await new RelayManagerTUI(ctx, pi, config, name || undefined).run();
				ctx.ui.notify(saved ? "Changes saved. Models updated in Pi." : "Cancelled without saving.", "info");
			} catch (error) {
				ctx.ui.notify(safeError(error), "error");
			}
		},
	});
}
