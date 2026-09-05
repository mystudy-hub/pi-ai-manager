// TUI Renderer - Pure rendering logic for AI Gateway TUI
// Separated from tui.ts for better maintainability

import type { DiscoveredModel, RelayConfig, ProviderEntry } from "./types.ts";
import type { TUIState } from "./tui-state.ts";

export interface RenderContext {
	config: RelayConfig;
	state: TUIState;
	selectedGateway: string;
	models: DiscoveredModel[];
	filteredModels: DiscoveredModel[];
	visibleModels: DiscoveredModel[];
	scrollOffset: number;
	visibleRows: number;
	hasUndoableOperation: boolean;
}

/**
 * Render the main browse mode table
 */
export function renderBrowseMode(ctx: RenderContext): string {
	const lines: string[] = [];

	// Header
	lines.push(renderHeader(ctx));
	lines.push("");

	// Gateway selector
	lines.push(renderGatewaySelector(ctx));
	lines.push("");

	// Model table
	lines.push(renderModelTable(ctx));
	lines.push("");

	// Status bar
	lines.push(renderStatusBar(ctx));

	return lines.join("\n");
}

/**
 * Render header with title and stats
 */
function renderHeader(ctx: RenderContext): string {
	const totalModels = ctx.models.length;
	const enabledCount = ctx.models.filter(m => m.enabled).length;
	const filteredCount = ctx.filteredModels.length;

	let stats = `${enabledCount}/${totalModels} enabled`;
	if (filteredCount < totalModels) {
		stats += ` (${filteredCount} shown)`;
	}

	return `AI Gateway Manager v3.1 - ${stats}`;
}

/**
 * Render gateway selector bar
 */
function renderGatewaySelector(ctx: RenderContext): string {
	const gateways = Object.keys(ctx.config.providers);
	if (gateways.length === 0) {
		return "No gateways configured. Press 'n' to add one.";
	}

	const parts = gateways.map(name => {
		const isSelected = name === ctx.selectedGateway;
		const entry = ctx.config.providers[name];
		const modelCount = ctx.models.length;

		if (isSelected) {
			return `[ ${name} (${modelCount}) ]`;
		} else {
			return `  ${name} (${modelCount})  `;
		}
	});

	return `Gateways: ${parts.join(" ")}  (← → to switch)`;
}

/**
 * Render the model table
 */
function renderModelTable(ctx: RenderContext): string {
	if (ctx.visibleModels.length === 0) {
		return "No models found. Press 'r' to refresh or '/' to clear filter.";
	}

	const lines: string[] = [];

	// Table header
	lines.push(renderTableHeader());
	lines.push("─".repeat(80));

	// Table rows
	for (let i = 0; i < ctx.visibleModels.length; i++) {
		const model = ctx.visibleModels[i];
		const absoluteIndex = ctx.scrollOffset + i;
		const isSelected = absoluteIndex === ctx.state.selectedIndex;

		lines.push(renderModelRow(model, isSelected));
	}

	// Scroll indicator
	if (ctx.filteredModels.length > ctx.visibleRows) {
		const scrollPercent = Math.round(
			(ctx.scrollOffset / (ctx.filteredModels.length - ctx.visibleRows)) * 100
		);
		lines.push("");
		lines.push(`Showing ${ctx.scrollOffset + 1}-${ctx.scrollOffset + ctx.visibleModels.length} of ${ctx.filteredModels.length} (${scrollPercent}%)`);
	}

	return lines.join("\n");
}

/**
 * Render table header
 */
function renderTableHeader(): string {
	return "  Status  Model ID                                Quality  API Type  Speed";
}

/**
 * Render a single model row
 */
function renderModelRow(model: DiscoveredModel, isSelected: boolean): string {
	const cursor = isSelected ? "→" : " ";
	const status = model.enabled ? "[✓]" : "[ ]";
	const modelId = truncate(model.id, 40);
	const quality = formatQuality(model.quality);
	const apiType = formatApiType(model.apiType);
	const speed = formatSpeed(model.latencyMs);

	return `${cursor} ${status}  ${modelId}  ${quality}  ${apiType}  ${speed}`;
}

/**
 * Render status bar with help shortcuts
 */
function renderStatusBar(ctx: RenderContext): string {
	const parts: string[] = [];

	// Basic shortcuts
	parts.push("Space: toggle");
	parts.push("a: auto-select");
	parts.push("d: dedup");
	parts.push("e/x: enable/disable pattern");

	// Undo shortcut (only if there's an operation to undo)
	if (ctx.hasUndoableOperation) {
		parts.push("u: undo");
	}

	// Other shortcuts
	parts.push("/: filter");
	parts.push("?: help");
	parts.push("q: quit");

	return parts.join(" | ");
}

/**
 * Render help mode screen
 */
export function renderHelpMode(): string {
	const lines: string[] = [];

	lines.push("AI Gateway Manager - Help");
	lines.push("=".repeat(60));
	lines.push("");

	lines.push("Navigation:");
	lines.push("  ↑↓              Select model");
	lines.push("  ←→              Switch gateway");
	lines.push("  /               Filter models");
	lines.push("  s               Toggle sort mode");
	lines.push("  q               Toggle quality filter");
	lines.push("");

	lines.push("Model Operations:");
	lines.push("  Space           Toggle model enabled/disabled");
	lines.push("  t               Test selected model");
	lines.push("  T               Test all enabled models");
	lines.push("  p               Change API type for selected model");
	lines.push("");

	lines.push("Batch Operations:");
	lines.push("  a               Auto-select recommended models");
	lines.push("  d               Dedup (disable slower duplicates)");
	lines.push("  e               Enable models by pattern");
	lines.push("  x               Disable models by pattern");
	lines.push("  u               Undo last operation ⭐ NEW");
	lines.push("");

	lines.push("Gateway Management:");
	lines.push("  n               Add new gateway");
	lines.push("  D or dd         Delete current gateway");
	lines.push("  r               Refresh current gateway");
	lines.push("  R               Refresh all gateways");
	lines.push("  A               Auto-discover gateways");
	lines.push("");

	lines.push("Other:");
	lines.push("  ?               Show/hide this help");
	lines.push("  Enter           Save and exit");
	lines.push("  Esc             Cancel (don't save)");
	lines.push("");

	lines.push("=".repeat(60));
	lines.push("Press ? to return to browse mode");

	return lines.join("\n");
}

/**
 * Render filter input mode
 */
export function renderFilterMode(pattern: string): string {
	return `Filter: ${pattern}_`;
}

/**
 * Render pattern enable/disable mode
 */
export function renderPatternMode(mode: "enable" | "disable", pattern: string): string {
	const action = mode === "enable" ? "Enable" : "Disable";
	return `${action} models matching pattern: ${pattern}_`;
}

/**
 * Render confirmation dialog
 */
export function renderConfirmation(message: string, action: string): string {
	const lines: string[] = [];

	lines.push("");
	lines.push("┌" + "─".repeat(60) + "┐");
	lines.push("│ " + message.padEnd(58) + " │");
	lines.push("│ " + " ".repeat(58) + " │");
	lines.push("│ " + `Press '${action}' to confirm, Esc to cancel`.padEnd(58) + " │");
	lines.push("└" + "─".repeat(60) + "┘");

	return lines.join("\n");
}

/**
 * Render form for adding new gateway
 */
export function renderGatewayForm(
	fields: { name: string; baseUrl: string; apiKey: string },
	currentField: number,
	detectedApi?: string
): string {
	const lines: string[] = [];

	lines.push("Add New Gateway");
	lines.push("=".repeat(60));
	lines.push("");

	// Name field
	const nameCursor = currentField === 0 ? "→" : " ";
	lines.push(`${nameCursor} Name:    ${fields.name}_`);

	// Base URL field
	const urlCursor = currentField === 1 ? "→" : " ";
	lines.push(`${urlCursor} Base URL: ${fields.baseUrl}_`);

	// API Key field
	const keyCursor = currentField === 2 ? "→" : " ";
	const maskedKey = fields.apiKey ? "*".repeat(fields.apiKey.length) : "";
	lines.push(`${keyCursor} API Key:  ${maskedKey}_`);

	// Detected API
	if (detectedApi) {
		lines.push("");
		lines.push(`Detected API: ${detectedApi}`);
	}

	lines.push("");
	lines.push("↑↓: navigate | Tab: next field | Enter: save | Esc: cancel");

	return lines.join("\n");
}

// ========== Utility Functions ==========

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) {
		return str.padEnd(maxLen);
	}
	return str.substring(0, maxLen - 3) + "...";
}

function formatQuality(quality?: string): string {
	if (!quality) return "unknown".padEnd(8);

	const colors: Record<string, string> = {
		good: "good    ",
		ok: "ok      ",
		poor: "poor    ",
		garbage: "garbage ",
	};

	return colors[quality] || quality.padEnd(8);
}

function formatApiType(apiType?: string): string {
	if (!apiType) return "unknown".padEnd(10);
	return apiType.padEnd(10);
}

function formatSpeed(latencyMs?: number): string {
	if (!latencyMs) return "untested";
	if (latencyMs < 1000) return `${latencyMs}ms`;
	return `${(latencyMs / 1000).toFixed(1)}s`;
}

/**
 * Render notification message
 */
export function renderNotification(message: string, type: "info" | "success" | "warning" | "error"): string {
	const icons: Record<string, string> = {
		info: "ℹ",
		success: "✓",
		warning: "⚠",
		error: "✗",
	};

	const icon = icons[type] || "ℹ";
	return `${icon} ${message}`;
}

/**
 * Render progress indicator
 */
export function renderProgress(current: number, total: number, message: string): string {
	const percent = Math.round((current / total) * 100);
	const barWidth = 40;
	const filled = Math.round((current / total) * barWidth);
	const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

	return `${message}: [${bar}] ${current}/${total} (${percent}%)`;
}
