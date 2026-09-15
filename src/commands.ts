import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { RelayManagerTUI } from "./tui.ts";
import { safeError, safeDisplay } from "./security.ts";
import { syncMaskitRules } from "./shield/sync.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ai-manager", {
		description: "Interactive AI gateway manager (add/remove providers, models, testing)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = (args || "").trim();
			if (trimmed === "sync-shield" || trimmed === "sync") {
				ctx.ui.notify("正在从 Data Maskit 上游同步脱敏规则...", "info");
				try {
					const res = await syncMaskitRules();
					const newCat = res.newCategories.length > 0 ? ` (新增类别: ${res.newCategories.join(", ")})` : "";
					ctx.ui.notify(`✓ 成功从 Maskit 同步升级！共加载 ${res.totalRules} 条规则${newCat}`, "info");
				} catch (error) {
					ctx.ui.notify(`Maskit 规则同步失败: ${safeError(error)}`, "error");
				}
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("ai-manager requires TUI mode.", "error");
				return;
			}
			try {
				const config = readConfig();
				// An empty config opens directly into the add-provider form.
				const name = trimmed;
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
