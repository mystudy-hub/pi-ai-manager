// ---------------------------------------------------------------------------
// Advanced TUI Interface — Interactive Model Manager for ai-gateway
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { matchesGlob, padToWidth, validateName } from "./utils.ts";
import type {
	RelayConfig,
	RelayProviderEntry,
	RelayModelMeta,
	TestResult,
	PerformanceMetrics,
	HealthStatus,
	FilterMode,
	QualityFilter,
	SortMode,
	RelayApi,
} from "./types.ts";
import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_REQUEST_DELAY_MS, DEFAULT_TEST_QUESTIONS, SUPPORTED_APIS } from "./types.ts";
import { scoreModel, filterModels, type ModelQualityScore } from "./model-scoring.ts";
import { writeConfig, syncScopedModels, canonicalBaseUrl, flushConfig } from "./config.ts";
import { RateLimiter, fetchModelList, compileOverrides, type DiscoveredModel } from "./network.ts";
import { registerProviderFor, applyDiscovery } from "./provider.ts";
import { testModelsInParallel, testModel as testModelFn, pickQuestions, applyTestResultToMeta } from "./testing.ts";
import { normalizeModelName, findDuplicateModels, compareInstances } from "./dedup.ts";
import { detectDefaultApi } from "./api-detect.ts";
import { inferReasoningSupport, inferThinkingLevelMap, inferModelCompat } from "./reasoning.ts";
import { TextInput } from "./tui-input.ts";
import { OperationHistory, type Operation } from "./tui-state.ts";

// ---------------------------------------------------------------------------
// Local types for TUI state
// ---------------------------------------------------------------------------

interface ModelRow {
	id: string;
	enabled: boolean;
	testing: boolean;
	testResult?: TestResult;
	meta: RelayModelMeta;
	qualityScore?: ModelQualityScore;
}

type TuiMode = "browse" | "form" | "pattern" | "help";

interface TUIState {
	mode: TuiMode;
	activePane: "gateways" | "models";
	selectedGateway: string;
	gatewayScrollOffset: number;
	selectedModelIndex: number;
	scrollOffset: number;
	modelRows: ModelRow[];
	filteredRows: ModelRow[];
	isFiltering: boolean;
	filterMode: FilterMode;
	sortMode: SortMode;
	qualityFilter: QualityFilter;
	testingInProgress: boolean;
	testProgress: { current: number; total: number };
}

interface AddProviderForm {
	/** name, baseUrl, apiKey */
	fields: [TextInput, TextInput, TextInput];
	fieldIndex: number;
	apiIndex: number;
	detectState: "idle" | "detecting" | "done";
	status: string;
	statusKind: "info" | "warning" | "error";
	discovered?: DiscoveredModel[];
}

const API_CHOICES: readonly RelayApi[] = [...SUPPORTED_APIS];
const DEFAULT_API_INDEX = API_CHOICES.indexOf("openai-completions");

/** States the `p` key cycles through for the selected model. "auto" = no pin, follow discovery. */
const API_CYCLE: readonly (RelayApi | "auto")[] = ["auto", "anthropic-messages", "openai-responses", "openai-completions"];

/** Short per-row labels for the effective API. */
const API_TAGS: Record<RelayApi, string> = {
	"anthropic-messages": "anthropic",
	"openai-completions": "completions",
	"openai-responses": "responses",
};

/** Exact-match regex rule key for a model id, used as a modelApiOverrides entry. */
function exactApiRule(modelId: string): string {
	return `^${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Keys shown in the help mode; also the source of truth for the help bar. */
const HELP_TEXT: readonly string[] = [
	"AI Gateway Manager — Keyboard Shortcuts",
	"",
	"Navigation:",
	"  ↑↓ / PgUp PgDn  Move selection (active pane)",
	"  ←→ / Tab        Switch between gateways and models panes",
	"",
	"Model actions:",
	"  Space           Toggle model enable/disable",
	"  t / T           Test selected / all visible models",
	"  p               Cycle model API (auto → anthropic → responses → completions)",
	"  g / b           Toggle thinking/reasoning support for model",
	"  c               Compare model across gateways",
	"",
	"Batch actions:",
	"  a               Auto-select recommended models",
	"  d               Dedup (disable slower duplicates)",
	"  e / x           Enable / disable models by glob pattern",
	"  u               Undo last operation",
	"",
	"Gateway actions:",
	"  n               Add provider (name, URL, key; API auto-detected)",
	"  D / dd          Delete selected provider (asks again)",
	"  r / R           Refresh current / all gateways",
	"  A               Test all gateways",
	"",
	"Filters & sort:",
	"  /               Search/filter models",
	"  q               Toggle quality filter (all/recommended/strict)",
	"  s               Cycle sort mode (name/status/performance/enabled)",
	"",
	"Other:",
	"  ?               Show this help",
	"  Enter           Save and exit",
	"  Esc             Cancel without saving",
];

// ---------------------------------------------------------------------------
// RelayManagerTUI
// ---------------------------------------------------------------------------

/**
 * pi's Component.render only receives a width, so the viewport height has to
 * come from the terminal directly. 30 is the fallback for a non-TTY stdout.
 */
function terminalHeight(): number {
	const rows = process.stdout.rows;
	return typeof rows === "number" && rows > 0 ? rows : 30;
}

export class RelayManagerTUI {
	private state: TUIState;
	private config: RelayConfig;
	private readonly ctx: ExtensionCommandContext;
	private readonly pi: ExtensionAPI;
	private visibleRows: number = 10;
	/** Whether the session ended via Enter (saved) rather than Esc (cancelled). */
	private saved = false;
	/**
	 * enabledModels per gateway at launch. Esc restores these even after a
	 * mid-session flush (see cancel()).
	 */
	private readonly initialEnabled: Map<string, readonly string[]>;
	private readonly filterInput = new TextInput();
	private pattern: { kind: "enable" | "disable"; input: TextInput } | null = null;
	private form: AddProviderForm | null = null;
	/** Gateway pending deletion confirmation. */
	private confirmDelete: string | null = null;
	/** An async form action is in flight; all keys are swallowed. */
	private busy = false;
	/** Tracks the last key for vim-style double-press (dd to delete). */
	private lastKey = "";
	/** Operation history for undo/redo functionality. */
	private operationHistory = new OperationHistory();

	constructor(ctx: ExtensionCommandContext, pi: ExtensionAPI, config: RelayConfig, initialGateway?: string) {
		this.ctx = ctx;
		this.pi = pi;
		this.config = config;
		this.initialEnabled = new Map(
			Object.entries(config.providers).map(([name, entry]) => [name, [...entry.enabledModels]] as const),
		);

		const gateways = Object.keys(config.providers);
		const selectedGateway =
			initialGateway && gateways.includes(initialGateway) ? initialGateway : gateways[0] ?? "";

		this.state = {
			mode: "browse",
			activePane: "models",
			selectedGateway,
			gatewayScrollOffset: 0,
			selectedModelIndex: 0,
			scrollOffset: 0,
			modelRows: [],
			filteredRows: [],
			isFiltering: false,
			filterMode: "all",
			sortMode: "status",
			qualityFilter: "recommended",
			testingInProgress: false,
			testProgress: { current: 0, total: 0 },
		};

		this.loadModels();

		// With no gateways configured the manager opens straight into the
		// add-provider form — it is the only onboarding path left.
		if (gateways.length === 0) this.openAddForm();
	}

	// ---- data helpers ----

	private loadModels(): void {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) {
			this.state.modelRows = [];
			this.state.filteredRows = [];
			return;
		}

		this.state.modelRows = Object.entries(entry.models).map(([id, meta]) => ({
			id,
			enabled: entry.enabledModels.includes(id),
			testing: false,
			meta,
			qualityScore: scoreModel(id),
		}));

		this.applyFiltersAndSort();
	}

	private applyFiltersAndSort(): void {
		let filtered = [...this.state.modelRows];

		// Quality filter
		if (this.state.qualityFilter !== "all") {
			const modelIds = filtered.map(r => r.id);
			const filteredIds = new Set(filterModels(modelIds, this.state.qualityFilter));
			filtered = filtered.filter(r => filteredIds.has(r.id));
		}

		// Text filter
		const search = this.filterInput.value.toLowerCase();
		if (search) {
			filtered = filtered.filter(row => row.id.toLowerCase().includes(search));
		}

		// Mode filter
		switch (this.state.filterMode) {
			case "enabled":
				filtered = filtered.filter(row => row.enabled);
				break;
			case "healthy":
				filtered = filtered.filter(row => row.meta.health?.status === "healthy");
				break;
			case "untested":
				filtered = filtered.filter(row => !row.meta.health || row.meta.health.status === "unknown");
				break;
		}

		// Sort
		filtered.sort((a, b) => {
			switch (this.state.sortMode) {
				case "name":
					return a.id.localeCompare(b.id);
				case "status": {
					const statusOrder = { healthy: 0, degraded: 1, down: 2, unknown: 3 };
					const aStatus = a.meta.health?.status ?? "unknown";
					const bStatus = b.meta.health?.status ?? "unknown";
					const statusCmp = statusOrder[aStatus] - statusOrder[bStatus];
					if (statusCmp !== 0) return statusCmp;
					return a.id.localeCompare(b.id);
				}
				case "performance": {
					const aTime = a.meta.metrics?.avgResponseTime ?? Infinity;
					const bTime = b.meta.metrics?.avgResponseTime ?? Infinity;
					return aTime - bTime;
				}
				case "enabled":
					if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
					return a.id.localeCompare(b.id);
				default:
					return 0;
			}
		});

		this.state.filteredRows = filtered;

		// Clamp selection
		if (this.state.selectedModelIndex >= filtered.length) {
			this.state.selectedModelIndex = Math.max(0, filtered.length - 1);
		}
	}

	private clampScroll(): void {
		const maxScroll = Math.max(0, this.state.filteredRows.length - this.visibleRows);
		this.state.scrollOffset = Math.max(0, Math.min(this.state.scrollOffset, maxScroll));
		if (this.state.selectedModelIndex < this.state.scrollOffset) {
			this.state.scrollOffset = this.state.selectedModelIndex;
		} else if (this.state.selectedModelIndex >= this.state.scrollOffset + this.visibleRows) {
			this.state.scrollOffset = this.state.selectedModelIndex - this.visibleRows + 1;
		}
	}

	/** Keep the selected gateway inside the visible slice of the left pane. */
	private clampGatewayScroll(): void {
		const gateways = Object.keys(this.config.providers);
		const maxScroll = Math.max(0, gateways.length - this.visibleRows);
		this.state.gatewayScrollOffset = Math.max(0, Math.min(this.state.gatewayScrollOffset, maxScroll));
		const selected = gateways.indexOf(this.state.selectedGateway);
		if (selected < 0) return;
		if (selected < this.state.gatewayScrollOffset) {
			this.state.gatewayScrollOffset = selected;
		} else if (selected >= this.state.gatewayScrollOffset + this.visibleRows) {
			this.state.gatewayScrollOffset = selected - this.visibleRows + 1;
		}
	}

	// ---- formatting helpers ----

	private formatHealth(health?: HealthStatus): { symbol: string; color: string } {
		if (!health || health.status === "unknown") return { symbol: "•", color: "dim" };
		switch (health.status) {
			case "healthy": return { symbol: "✓", color: "success" };
			case "degraded": return { symbol: "⚠", color: "warning" };
			case "down": return { symbol: "✗", color: "error" };
		}
	}

	private formatMetrics(metrics?: PerformanceMetrics): string {
		if (!metrics) return "";
		const time = `${metrics.avgResponseTime}ms`;
		const tokens = metrics.avgTokens != null ? ` ${this.formatNumber(metrics.avgTokens)}tk` : "";
		return `${time}${tokens}`;
	}

	private formatNumber(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return String(n);
	}

	private formatTestResult(row: ModelRow): string {
		if (row.testing) return "⧗ testing...";
		if (row.testResult) {
			const { passed, total } = row.testResult;
			if (passed === 0) return `✗ ${passed}/${total}`;
			if (passed === total) return `✓ ${passed}/${total}`;
			return `⚠ ${passed}/${total}`;
		}
		return this.formatHealth(row.meta.health).symbol;
	}

	// ---- rendering ----

	/**
	 * Pad content to an exact number of visible columns.
	 *
	 * Everything here must be measured with visibleWidth rather than .length:
	 * ANSI styling contributes zero columns, while CJK text and emoji badges
	 * (⭐ 🗑) each occupy two. Counting code units instead ragged the frame.
	 */
	private cell(content: string, width: number): string {
		const truncated = truncateToWidth(content, width, "…");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	/** One framed body row: `│<left>│<right>│`, both cells measured. */
	private row(theme: any, left: string, right: string, leftWidth: number, rightWidth: number): string {
		const bar = theme.fg("accent", "│");
		return bar + this.cell(left, leftWidth) + bar + this.cell(right, rightWidth) + bar;
	}

	/**
	 * Cycle the selected model's API: auto → anthropic-messages → openai-responses
	 * → openai-completions → auto. A concrete choice is pinned via an exact-match
	 * rule in modelApiOverrides so refresh (applyDiscovery → resolveApi) keeps it;
	 * "auto" removes the pin and lets endpoint-type discovery decide again.
	 */
	private cycleModelApi(): void {
		const entry = this.config.providers[this.state.selectedGateway];
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!entry || !row || !entry.models[row.id]) return;
		const meta = entry.models[row.id];

		const rules = compileOverrides(entry.modelApiOverrides ?? {});
		const pinned = rules.find((r) => r.regex.test(row.id))?.api;
		const current = pinned ?? "auto";
		const next = API_CYCLE[(API_CYCLE.indexOf(current) + 1) % API_CYCLE.length];

		entry.modelApiOverrides ??= {};
		const ruleKey = exactApiRule(row.id);
		if (next === "auto") {
			delete entry.modelApiOverrides[ruleKey];
		} else {
			entry.modelApiOverrides[ruleKey] = next;
			meta.api = next;
		}
	}

	private toggleModelReasoning(): void {
		const entry = this.config.providers[this.state.selectedGateway];
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!entry || !row || !entry.models[row.id]) return;
		const meta = entry.models[row.id];

		const current = meta.reasoning ?? inferReasoningSupport(row.id);
		const next = !current;
		meta.reasoning = next;
		row.meta.reasoning = next;

		if (next) {
			const api = meta.api ?? entry.defaultApi;
			meta.thinkingLevelMap ??= inferThinkingLevelMap(row.id);
			meta.compat ??= inferModelCompat(row.id, api);
		}

		this.operationHistory.record({
			description: `Toggle reasoning for ${row.id} (${next ? "enabled" : "disabled"})`,
			undo: () => {
				meta.reasoning = current;
				row.meta.reasoning = current;
			},
		});

		this.ctx.ui.notify(
			`Reasoning ${next ? "enabled" : "disabled"} for ${row.id}`,
			"info",
		);
	}

	/** One framed full-width line: `│<content>│`. */
	private fullRow(theme: any, content: string, w: number): string {
		return theme.fg("accent", "│") + this.cell(content, w - 2) + theme.fg("accent", "│");
	}

	render(width: number, height: number, theme: any): string[] {
		// A component must never render wider than the width supplied by pi.
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		if (w < 20) return [truncateToWidth("AI Gateway", w, "")];

		// Chrome is 12 lines (borders, header, column headers, info, separator,
		// scroll, status, help bar); keep at least 5 model rows even on a short
		// terminal and cap at 20.
		this.visibleRows = Math.max(5, Math.min(h - 12, 20));
		this.clampScroll();
		this.clampGatewayScroll();

		const lines: string[] = [];
		const gateways = Object.keys(this.config.providers);
		const entry = this.config.providers[this.state.selectedGateway];

		const leftWidth = 24;
		const rightWidth = w - leftWidth - 3;

		// Header
		lines.push(theme.fg("accent", "┌" + "─".repeat(w - 2) + "┐"));
		lines.push(
			theme.fg("accent", "│") + this.cell(` ${theme.bold("AI Gateway 管理中心")}`, w - 2) + theme.fg("accent", "│"),
		);
		lines.push(theme.fg("accent", "├" + "─".repeat(w - 2) + "┤"));

		if (this.state.mode === "help") {
			for (const help of HELP_TEXT.slice(0, this.visibleRows + 4)) {
				lines.push(this.fullRow(theme, ` ${help}`, w));
			}
			lines.push(theme.fg("accent", "└" + "─".repeat(w - 2) + "┘"));
			return lines.map((line) => padToWidth(line, w));
		}

		if (this.state.mode === "form" && this.form) {
			lines.push(...this.renderForm(theme, w));
			lines.push(theme.fg("accent", "└" + "─".repeat(w - 2) + "┘"));
			return lines.map((line) => padToWidth(line, w));
		}

		// Column headers
		lines.push(
			this.row(
				theme,
				` ${theme.bold(`Gateways (${gateways.length})`)}`,
				` ${theme.bold(`Models - ${this.state.selectedGateway || "—"}`)}`,
				leftWidth,
				rightWidth,
			),
		);

		if (entry) {
			const discovered = Object.keys(entry.models).length;
			const enabled = entry.enabledModels.length;
			const filterInfo = this.filterInput.value ? `[Filter: ${this.filterInput.value}] ` : "";
			const view = `${filterInfo}[Sort: ${this.state.sortMode}] [Quality: ${this.state.qualityFilter}]`;
			lines.push(
				this.row(theme, "", ` ${theme.fg("dim", `${discovered} discovered, ${enabled} enabled  ${view}`)}`, leftWidth, rightWidth),
			);
		} else {
			lines.push(this.row(theme, "", "", leftWidth, rightWidth));
		}

		lines.push(
			theme.fg("accent", "│") + " ".repeat(leftWidth) + theme.fg("accent", "│") + "─".repeat(rightWidth) + theme.fg("accent", "│"),
		);

		// Body: gateway list (left) and model list (right) share the rows.
		const apiRules = entry ? compileOverrides(entry.modelApiOverrides ?? {}) : [];
		const visibleGateways = gateways.slice(
			this.state.gatewayScrollOffset,
			this.state.gatewayScrollOffset + this.visibleRows,
		);
		const visibleModels = this.state.filteredRows.slice(
			this.state.scrollOffset,
			this.state.scrollOffset + this.visibleRows,
		);

		for (let i = 0; i < this.visibleRows; i++) {
			const gateway = visibleGateways[i];
			let left = "";
			if (gateway) {
				const gatewayEntry = this.config.providers[gateway];
				const isSelected = gateway === this.state.selectedGateway;
				const paneActive = this.state.activePane === "gateways";
				const marker = isSelected ? (paneActive ? theme.fg("accent", ">") : theme.fg("dim", ">")) : " ";
				const configured = this.ctx.modelRegistry.getProviderAuthStatus(gateway).configured;
				const auth = configured ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const counts = `${gatewayEntry.enabledModels.length}/${Object.keys(gatewayEntry.models).length}`;
				left = ` ${marker} ${isSelected && paneActive ? theme.bold(gateway) : gateway} ${auth} ${counts}`;
			}

			const row = visibleModels[i];
			let right = "";
			if (row) {
				const absoluteIndex = this.state.scrollOffset + i;
				const isSelected = this.state.activePane === "models" && absoluteIndex === this.state.selectedModelIndex;
				const marker = isSelected ? theme.fg("accent", ">") : " ";
				const checkbox = row.enabled ? theme.fg("success", "☑") : "☐";

				let qualityBadge = "";
				if (row.qualityScore) {
					if (row.qualityScore.isKnownGood) qualityBadge = theme.fg("success", "⭐");
					else if (row.qualityScore.isGarbage) qualityBadge = theme.fg("error", "🗑");
					else if (row.qualityScore.recommendScore >= 60) qualityBadge = theme.fg("dim", "○");
				}

				const health = this.formatHealth(row.meta.health);
				const healthSymbol = theme.fg(health.color, health.symbol);
				const status = `${healthSymbol} ${this.formatTestResult(row)} ${this.formatMetrics(row.meta.metrics)}`;
				const badge = qualityBadge ? ` ${qualityBadge}` : "";
				const isReasoning = row.meta.reasoning ?? inferReasoningSupport(row.id);
				const thinkBadge = isReasoning ? ` ${theme.fg("warning", "🧠")}` : "";

				const pinned = apiRules.find((r) => r.regex.test(row.id))?.api;
				const effectiveApi = pinned ?? row.meta.api ?? entry?.defaultApi ?? "openai-responses";
				const apiTag = theme.fg(pinned ? "accent" : "dim", API_TAGS[effectiveApi]);

				right = ` ${marker} ${checkbox} ${row.id}${badge}${thinkBadge} ${apiTag}  ${status}`;
			}

			lines.push(this.row(theme, left, right, leftWidth, rightWidth));
		}

		// Scroll indicator
		{
			const left =
				gateways.length > this.visibleRows
					? ` ${theme.fg("dim", `(${this.state.gatewayScrollOffset + 1}-${Math.min(this.state.gatewayScrollOffset + this.visibleRows, gateways.length)}/${gateways.length})`)}`
					: "";
			const right =
				this.state.filteredRows.length > this.visibleRows
					? ` ${theme.fg("dim", `(${this.state.scrollOffset + 1}-${Math.min(this.state.scrollOffset + this.visibleRows, this.state.filteredRows.length)}/${this.state.filteredRows.length})`)}`
					: "";
			lines.push(this.row(theme, left, right, leftWidth, rightWidth));
		}

		// Status row: test progress, pattern input, or deletion confirmation.
		{
			let status = "";
			if (this.state.testingInProgress) {
				const { current, total } = this.state.testProgress;
				status = ` ${theme.fg("warning", `⧗ Testing ${current}/${total}...`)}`;
			} else if (this.pattern) {
				const label = this.pattern.kind === "enable" ? "Enable pattern" : "Disable pattern";
				status = ` ${theme.fg("accent", `${label}:`)} ${this.pattern.input.render(theme, rightWidth - 6)} ${theme.fg("dim", "(Enter apply, Esc cancel)")}`;
			} else if (this.confirmDelete) {
				status = ` ${theme.fg("error", `Delete gateway "${this.confirmDelete}"?`)} ${theme.fg("warning", "D / d / Enter to confirm, Esc to cancel")}`;
			} else if (this.lastKey === "d") {
				status = ` ${theme.fg("warning", "d pressed — press d again to delete this gateway, any other key to cancel")}`;
			}
			lines.push(this.row(theme, "", status, leftWidth, rightWidth));
		}

		// Help bar
		lines.push(theme.fg("accent", "├" + "─".repeat(w - 2) + "┤"));

		const undoHint = this.operationHistory.canUndo()
			? ` | ${theme.fg("accent", "u")}: undo`
			: "";

		const helpLines = this.state.isFiltering
			? ["Type to filter... (Enter: apply, Esc: cancel)"]
			: [
					`Space: toggle | g: think | t: test | T: test all | p: api | a: auto | d: dedup | e/x: pattern${undoHint} | ?: help`,
					"n: add provider | D/dd: delete | ↑↓←→: nav | /: filter | s: sort | q: quality | r/R/A | Enter/Esc",
				];
		for (const help of helpLines) {
			lines.push(theme.fg("accent", "│") + this.cell(` ${theme.fg("dim", help)}`, w - 2) + theme.fg("accent", "│"));
		}

		lines.push(theme.fg("accent", "└" + "─".repeat(w - 2) + "┘"));

		return lines.map((line) => padToWidth(line, w));
	}

	private renderForm(theme: any, w: number): string[] {
		const f = this.form;
		if (!f) return [];
		const lines: string[] = [this.fullRow(theme, ` ${theme.bold("Add provider")}${theme.fg("dim", "  (Esc cancels)")}`, w)];

		const labels = ["Name", "Base URL", "API Key"] as const;
		const labelWidth = 10;
		const fieldWidth = w - 2 - labelWidth - 2;
		for (let i = 0; i < 3; i++) {
			const focused = f.fieldIndex === i;
			const label = focused ? theme.bold(` ${labels[i]}`) : theme.fg("dim", ` ${labels[i]}`);
			const field = focused
				? theme.fg("accent", "› ") + f.fields[i].render(theme, fieldWidth - 2)
				: "  " + theme.fg("dim", i === 2 ? "*".repeat(Math.min(f.fields[2].value.length, fieldWidth - 2)) : truncateToWidth(f.fields[i].value, fieldWidth - 2));
			lines.push(
				theme.fg("accent", "│") +
					this.cell(label, labelWidth) +
					this.cell(field, fieldWidth) +
					theme.fg("accent", "│"),
			);
		}

		// API field
		const apiFocused = f.fieldIndex === 3;
		const api = API_CHOICES[f.apiIndex];
		const detectNote =
			f.detectState === "detecting"
				? theme.fg("warning", "detecting…")
				: f.detectState === "done" && f.statusKind === "info"
					? theme.fg("dim", f.status)
					: theme.fg("dim", "←→ to change");
		const apiLine = ` ${apiFocused ? theme.bold("API") : theme.fg("dim", "API")}  ${apiFocused ? theme.fg("accent", api) : api}  ${detectNote}`;
		lines.push(this.fullRow(theme, apiLine, w));

		// Status message
		const statusColor = f.statusKind === "error" ? "error" : f.statusKind === "warning" ? "warning" : "dim";
		lines.push(this.fullRow(theme, ` ${f.status ? theme.fg(statusColor, f.status) : theme.fg("dim", "Enter on the API field saves the provider")}`, w));

		lines.push(this.fullRow(theme, theme.fg("dim", " ↑↓/Tab: fields | Enter: next (save on API) | ←→: cycle API | Esc: cancel"), w));

		while (lines.length < this.visibleRows + 4) lines.push(this.fullRow(theme, "", w));
		return lines.slice(0, this.visibleRows + 4);
	}

	private selectGateway(offset: number): void {
		const gateways = Object.keys(this.config.providers);
		if (gateways.length === 0) return;
		const currentIndex = Math.max(0, gateways.indexOf(this.state.selectedGateway));
		const nextIndex = Math.max(0, Math.min(gateways.length - 1, currentIndex + offset));
		const nextGateway = gateways[nextIndex];
		if (!nextGateway || nextGateway === this.state.selectedGateway) return;
		this.state.selectedGateway = nextGateway;
		this.state.selectedModelIndex = 0;
		this.state.scrollOffset = 0;
		this.loadModels();
	}

	private async testModels(modelIds: string[]): Promise<void> {
		this.state.testingInProgress = true;
		this.state.testProgress = { current: 0, total: modelIds.length };

		const questions =
			this.config.settings.testQuestions && this.config.settings.testQuestions.length > 0
				? this.config.settings.testQuestions
				: [...DEFAULT_TEST_QUESTIONS];

		const concurrency = this.config.settings.testConcurrency ?? DEFAULT_TEST_CONCURRENCY;
		const delayMs = this.config.settings.testRequestDelayMs ?? DEFAULT_TEST_REQUEST_DELAY_MS;
		const rateLimiter = new RateLimiter(delayMs);

		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) {
			this.state.testingInProgress = false;
			return;
		}

		// Register the union of the enabled set and the models under test. Testing
		// a currently-disabled model still has to reach the registry, but
		// narrowing registration to just the tested ones would hide every other
		// model from the user mid-run.
		const underTest = [...new Set([...entry.enabledModels, ...modelIds])];
		registerProviderFor(this.pi, this.state.selectedGateway, entry, underTest);

		try {
			const results = await testModelsInParallel(
				this.ctx,
				this.state.selectedGateway,
				modelIds,
				questions,
				concurrency,
				rateLimiter,
				(modelId, current, total) => {
					this.state.testProgress = { current, total };
					const row = this.state.modelRows.find(r => r.id === modelId);
					if (row) row.testing = true;
				},
			);

			for (const [modelId, result] of results.entries()) {
				const row = this.state.modelRows.find(r => r.id === modelId);
				if (row) {
					row.testing = false;
					row.testResult = result;
				}
				const modelMeta = entry.models[modelId];
				if (modelMeta) applyTestResultToMeta(modelMeta, result);
			}

			writeConfig(this.config);
			this.applyFiltersAndSort();
		} finally {
			this.state.testingInProgress = false;
			for (const row of this.state.modelRows) row.testing = false;
			// Back to the enabled-only registration.
			registerProviderFor(this.pi, this.state.selectedGateway, entry);
		}
	}

	private async refreshModels(): Promise<void> {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) return;

		try {
			const apiKey = entry.apiKey ?? (await this.ctx.modelRegistry.getApiKeyForProvider(this.state.selectedGateway));
			this.ctx.ui.setStatus("ai-manager", `discovering ${this.state.selectedGateway}…`);

			const list = await fetchModelList(entry.baseUrl, apiKey);
			applyDiscovery(entry, list);

			writeConfig(this.config);
			this.loadModels();
			this.ctx.ui.notify(`Discovered ${list.length} models for "${this.state.selectedGateway}"`, "info");
		} catch (error) {
			this.ctx.ui.notify(
				`Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			this.ctx.ui.setStatus("ai-manager", undefined);
		}
	}

	private save(): void {
		// Flush any pending writes before saving
		try {
			flushConfig();
		} catch {
			// flushConfig failed, writeConfig will handle it
		}

		writeConfig(this.config);
		// Every gateway, not just the selected one: the user can toggle models in
		// several gateways in one session, and writeConfig persists all of them.
		// Syncing only the visible one silently strands the rest — they land in
		// provider-ai.json but never reach pi or settings.json.
		for (const [name, entry] of Object.entries(this.config.providers)) {
			registerProviderFor(this.pi, name, entry);
			syncScopedModels(name, entry);
		}
	}

	/**
	 * Undo selection changes on Esc.
	 *
	 * a/d/e/x and Space only mutate memory, but r/R/t/T/A flush to disk
	 * mid-session — and those flushes capture whatever enabledModels looked
	 * like at the time. So "cancel" cannot be purely in-memory: restore the
	 * launch-time selections and flush once. Health/metrics/discovery data
	 * gathered along the way is telemetry and is deliberately kept. Providers
	 * added or deleted mid-session are also kept: those are committed actions.
	 */
	private cancel(): void {
		let reverted = false;
		for (const [name, enabled] of this.initialEnabled) {
			const entry = this.config.providers[name];
			if (!entry) continue;
			if (entry.enabledModels.length !== enabled.length || entry.enabledModels.some((id, i) => id !== enabled[i])) {
				entry.enabledModels = [...enabled];
				reverted = true;
			}
		}
		if (!reverted) return;
		writeConfig(this.config);
		// A mid-session test registered providers with the modified list; put
		// pi's registry back in sync with what is now on disk.
		for (const [name, entry] of Object.entries(this.config.providers)) {
			registerProviderFor(this.pi, name, entry);
		}
	}

	// ---- batch actions ----

	private async autoSelectModels(): Promise<void> {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) return;

		const previousState = [...entry.enabledModels];

		const allModelIds = Object.keys(entry.models);
		const recommended = allModelIds.filter(id => {
			const score = scoreModel(id);
			return score.recommendScore >= 60 && !score.isGarbage;
		});

		// Merge: keep user's existing manual selections, add recommended ones
		const merged = [...new Set([...entry.enabledModels, ...recommended])];
		const newAdded = merged.length - entry.enabledModels.length;
		entry.enabledModels = merged;

		// Record operation for undo
		this.recordOperation(
			"auto-select",
			this.state.selectedGateway,
			`Auto-selected ${recommended.length} models (${newAdded} new)`,
			previousState,
			entry.enabledModels
		);

		this.loadModels();
		this.ctx.ui.notify(
			`Auto-selected ${recommended.length} recommended models (${newAdded} new, kept existing selections)`,
			"info",
		);
	}

	private async dedupModels(): Promise<void> {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) return;

		const previousState = [...entry.enabledModels];

		const dupes = findDuplicateModels(this.config);
		const currentGateway = this.state.selectedGateway;
		let disabledCount = 0;

		for (const group of dupes) {
			const inCurrentGateway = group.instances.filter(inst => inst.gateway === currentGateway);
			if (inCurrentGateway.length === 0) continue;

			const sorted = [...inCurrentGateway].sort(compareInstances);

			const slower = sorted.slice(1);
			for (const inst of slower) {
				entry.enabledModels = entry.enabledModels.filter(id => id !== inst.modelId);
				disabledCount++;
			}
		}

		// Record operation for undo
		if (disabledCount > 0) {
			this.recordOperation(
				"dedup",
				this.state.selectedGateway,
				`Disabled ${disabledCount} slower duplicates`,
				previousState,
				entry.enabledModels
			);
		}

		this.loadModels();
		if (disabledCount > 0) {
			this.ctx.ui.notify(`Disabled ${disabledCount} slower duplicate model(s)`, "info");
		} else {
			this.ctx.ui.notify("No duplicates found in this gateway", "info");
		}
	}

	private async compareModel(): Promise<void> {
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!row) return;

		const instances: Array<{ gateway: string; metrics?: PerformanceMetrics; health?: HealthStatus }> = [];
		const normalizedName = normalizeModelName(row.id);

		for (const [gatewayName, gatewayEntry] of Object.entries(this.config.providers)) {
			for (const [modelId, meta] of Object.entries(gatewayEntry.models)) {
				if (normalizeModelName(modelId) === normalizedName) {
					instances.push({ gateway: gatewayName, metrics: meta.metrics, health: meta.health });
				}
			}
		}

		if (instances.length <= 1) {
			this.ctx.ui.notify(`Model "${row.id}" not found in other gateways`, "info");
			return;
		}

		const lines: string[] = [`\nModel: ${row.id}`, `Found in ${instances.length} gateway(s):\n`];
		for (const inst of instances) {
			const time = inst.metrics?.avgResponseTime ?? "?";
			const health = inst.health?.status ?? "unknown";
			lines.push(`  ${inst.gateway}: ${time}ms (${health})`);
		}

		this.ctx.ui.notify(lines.join("\n"), "info");
	}

	private applyPattern(pattern: string, enable: boolean): void {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry || !pattern) return;

		const previousState = [...entry.enabledModels];

		if (enable) {
			const matches = Object.keys(entry.models).filter(id => matchesGlob(id, pattern));
			for (const modelId of matches) {
				if (!entry.enabledModels.includes(modelId)) entry.enabledModels.push(modelId);
			}

			// Record operation for undo
			if (matches.length > 0) {
				this.recordOperation(
					"enable-pattern",
					this.state.selectedGateway,
					`Enabled ${matches.length} models matching "${pattern}"`,
					previousState,
					entry.enabledModels
				);
			}

			this.loadModels();
			this.ctx.ui.notify(`Enabled ${matches.length} model(s) matching "${pattern}"`, "info");
		} else {
			const matches = entry.enabledModels.filter(id => matchesGlob(id, pattern));
			entry.enabledModels = entry.enabledModels.filter(id => !matches.includes(id));

			// Record operation for undo
			if (matches.length > 0) {
				this.recordOperation(
					"disable-pattern",
					this.state.selectedGateway,
					`Disabled ${matches.length} models matching "${pattern}"`,
					previousState,
					entry.enabledModels
				);
			}

			this.loadModels();
			this.ctx.ui.notify(`Disabled ${matches.length} model(s) matching "${pattern}"`, "info");
		}
	}

	private async refreshAllGateways(): Promise<void> {
		const gatewayNames = Object.keys(this.config.providers);
		let successCount = 0;
		let failCount = 0;

		this.ctx.ui.setStatus("ai-manager", `Refreshing ${gatewayNames.length} gateways…`);

		for (const name of gatewayNames) {
			const gatewayEntry = this.config.providers[name];
			try {
				const apiKey = gatewayEntry.apiKey ?? (await this.ctx.modelRegistry.getApiKeyForProvider(name));
				const list = await fetchModelList(gatewayEntry.baseUrl, apiKey);
				applyDiscovery(gatewayEntry, list);
				successCount++;
			} catch {
				failCount++;
			}
		}

		writeConfig(this.config);
		this.loadModels();
		this.ctx.ui.setStatus("ai-manager", undefined);
		this.ctx.ui.notify(
			`Refreshed ${successCount}/${gatewayNames.length} gateways (${failCount} failed)`,
			"info",
		);
	}

	/**
	 * Parallelized: tests all gateways concurrently with a shared RateLimiter
	 * to control total concurrency.
	 */
	private async testAllGateways(): Promise<void> {
		const gatewayNames = Object.keys(this.config.providers);
		let totalTested = 0;
		let totalPassed = 0;

		this.ctx.ui.setStatus("ai-manager", `Testing all gateways…`);

		const questions =
			this.config.settings.testQuestions && this.config.settings.testQuestions.length > 0
				? this.config.settings.testQuestions
				: [...DEFAULT_TEST_QUESTIONS];

		const concurrency = this.config.settings.testConcurrency ?? DEFAULT_TEST_CONCURRENCY;
		const delayMs = this.config.settings.testRequestDelayMs ?? DEFAULT_TEST_REQUEST_DELAY_MS;

		// Shared rate limiter across all gateways
		const sharedRateLimiter = new RateLimiter(delayMs);

		// Build a flat list of {gateway, modelId} pairs
		const allTasks: Array<{ gateway: string; modelId: string }> = [];
		for (const name of gatewayNames) {
			const gatewayEntry = this.config.providers[name];
			for (const modelId of gatewayEntry.enabledModels) {
				if (modelId in gatewayEntry.models) {
					allTasks.push({ gateway: name, modelId });
				}
			}
		}

		if (allTasks.length === 0) {
			this.ctx.ui.setStatus("ai-manager", undefined);
			return;
		}

		// Parallel worker pool across all gateways
		const queue = [...allTasks];
		let completed = 0;

		async function workerFn(this: RelayManagerTUI): Promise<void> {
			while (queue.length > 0) {
				const task = queue.shift();
				if (!task) break;

				const { gateway, modelId } = task;
				const meta = this.config.providers[gateway]?.models[modelId];
				if (!meta) continue;

				// Ensure provider is registered
				registerProviderFor(this.pi, gateway, this.config.providers[gateway]);

				const chosen = pickQuestions(questions, completed);
				try {
					const result = await testModelFn(this.ctx, gateway, modelId, chosen, sharedRateLimiter);
					if (!result.skipped) {
						totalTested++;
						totalPassed += result.passed;
					}
					applyTestResultToMeta(meta, result);
				} catch {
					// Ignore individual model errors
				}

				completed++;
				this.state.testProgress = { current: completed, total: allTasks.length };
			}
		}

		const workerCount = Math.max(1, Math.min(Math.floor(concurrency), allTasks.length));
		await Promise.all(Array.from({ length: workerCount }, () => workerFn.call(this)));

		writeConfig(this.config);
		this.loadModels();
		this.ctx.ui.setStatus("ai-manager", undefined);
		this.ctx.ui.notify(`Tested ${totalTested} model(s) across all gateways: ${totalPassed} prompt(s) passed`, "info");
	}

	// ---- add / delete provider ----

	private openAddForm(): void {
		this.form = {
			fields: [new TextInput(), new TextInput(), new TextInput(true)],
			fieldIndex: 0,
			apiIndex: DEFAULT_API_INDEX,
			detectState: "idle",
			status: "",
			statusKind: "info",
		};
		this.state.mode = "form";
	}

	/**
	 * Probe /v1/models once when the API field is first reached. Doubles as the
	 * reachability check: a failure is a warning, not a blocker.
	 */
	private async detectApiForForm(): Promise<void> {
		const f = this.form;
		if (!f || f.detectState !== "idle") return;
		const baseUrl = canonicalBaseUrl(f.fields[1].value);
		if (!baseUrl) return;

		f.detectState = "detecting";
		f.status = "detecting API from /v1/models…";
		f.statusKind = "info";
		this.busy = true;
		try {
			const key = f.fields[2].value || undefined;
			const list = await fetchModelList(baseUrl, key);
			f.discovered = list;
			const detected = detectDefaultApi(list);
			if (detected === "ambiguous") {
				f.apiIndex = DEFAULT_API_INDEX;
				f.status = `no consistent API family across ${list.length} models — choose manually`;
				f.statusKind = "warning";
			} else {
				f.apiIndex = API_CHOICES.indexOf(detected);
				f.status = `auto-detected ${detected} from ${list.length} models`;
			}
		} catch (error) {
			f.apiIndex = DEFAULT_API_INDEX;
			f.status = `gateway not reachable (${error instanceof Error ? error.message : String(error)}) — will still save`;
			f.statusKind = "warning";
		} finally {
			f.detectState = "done";
			this.busy = false;
		}
	}

	private async submitForm(): Promise<void> {
		const f = this.form;
		if (!f) return;

		const name = f.fields[0].value.trim();
		const nameError = validateName(name);
		if (nameError) {
			f.status = nameError;
			f.statusKind = "error";
			f.fieldIndex = 0;
			return;
		}
		if (this.config.providers[name]) {
			f.status = `Provider "${name}" already exists.`;
			f.statusKind = "error";
			f.fieldIndex = 0;
			return;
		}
		const baseUrl = canonicalBaseUrl(f.fields[1].value);
		if (!baseUrl) {
			f.status = "Invalid Base URL. Use an http(s) URL without credentials, query, or fragment.";
			f.statusKind = "error";
			f.fieldIndex = 1;
			return;
		}
		const apiKey = f.fields[2].value;

		const entry: RelayProviderEntry = {
			baseUrl,
			defaultApi: API_CHOICES[f.apiIndex],
			...(apiKey ? { apiKey } : {}),
			models: {},
			enabledModels: [],
		};

		// Reuse the probe from detectApiForForm when possible; otherwise try
		// once more so a reachable gateway comes pre-populated.
		let discovered = f.discovered;
		if (!discovered) {
			this.busy = true;
			f.status = "fetching models…";
			try {
				discovered = await fetchModelList(baseUrl, apiKey || undefined);
			} catch {
				discovered = [];
			} finally {
				this.busy = false;
			}
		}
		const counts = applyDiscovery(entry, discovered);

		// Auto-enable recommended models so they show up in pi immediately
		// (Ctrl+P cycling, scoped-models). The user can refine later in the UI.
		const allModelIds = Object.keys(entry.models);
		const recommended = allModelIds.filter(id => {
			const quality = scoreModel(id);
			return quality.recommendScore >= 60 && !quality.isGarbage;
		});
		entry.enabledModels = recommended;

		this.config.providers[name] = entry;
		this.state.selectedGateway = name;
		this.state.activePane = "models";
		this.state.selectedModelIndex = 0;
		this.state.scrollOffset = 0;
		this.state.gatewayScrollOffset = 0;
		writeConfig(this.config);
		registerProviderFor(this.pi, name, entry);
		syncScopedModels(name, entry);
		this.loadModels();

		this.form = null;
		this.state.mode = "browse";
		this.ctx.ui.notify(
			`Provider "${name}" added${counts.added > 0 ? ` (${counts.added} models discovered)` : ""}. Run /login ${name} or store a key if auth fails.`,
			"info",
		);
	}

	private deleteProvider(name: string): void {
		const entry = this.config.providers[name];
		if (!entry) return;

		// Clear scoped models before deleting the entry: afterwards the enabled
		// list is gone and computeScopedPatterns could not clean up patterns.
		syncScopedModels(name, { ...entry, enabledModels: [] });
		this.pi.unregisterProvider(name);
		delete this.config.providers[name];
		this.initialEnabled.delete(name);
		writeConfig(this.config);

		const gateways = Object.keys(this.config.providers);
		this.state.selectedGateway = this.state.selectedGateway === name ? (gateways[0] ?? "") : this.state.selectedGateway;
		this.state.selectedModelIndex = 0;
		this.state.scrollOffset = 0;
		this.loadModels();
		this.ctx.ui.notify(`Provider "${name}" removed. Credentials are not removed; run /logout separately.`, "info");
	}

	// ---- input handler ----

	async handleInput(data: string): Promise<boolean> {
		// Help exits on any key and must not leak into browse actions.
		if (this.state.mode === "help") {
			this.state.mode = "browse";
			return true;
		}

		// A network probe from the form is in flight; swallow everything.
		if (this.busy) return true;

		if (this.state.testingInProgress) {
			if (matchesKey(data, Key.escape)) {
				this.cancel();
				this.saved = false;
				return false;
			}
			return true;
		}

		if (this.state.mode === "form" && this.form) return this.handleFormInput(data);
		if (this.state.mode === "pattern" && this.pattern) return this.handlePatternInput(data);
		if (this.confirmDelete) return this.handleConfirmInput(data);

		// ---- browse mode ----

		if (this.state.isFiltering) {
			const action = this.filterInput.handleInput(data);
			if (action === "cancel") {
				this.filterInput.clear();
				this.state.isFiltering = false;
			} else if (action === "submit") {
				this.state.isFiltering = false;
			}
			this.applyFiltersAndSort();
			return true;
		}

		// Navigation
		if (matchesKey(data, Key.up)) {
			if (this.state.activePane === "models") {
				this.state.selectedModelIndex = Math.max(0, this.state.selectedModelIndex - 1);
			} else {
				this.selectGateway(-1);
			}
			return true;
		}

		if (matchesKey(data, Key.down)) {
			if (this.state.activePane === "models") {
				this.state.selectedModelIndex = Math.min(
					Math.max(0, this.state.filteredRows.length - 1),
					this.state.selectedModelIndex + 1,
				);
			} else {
				this.selectGateway(1);
			}
			return true;
		}

		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const direction = matchesKey(data, Key.pageUp) ? -1 : 1;
			if (this.state.activePane === "models") {
				this.state.selectedModelIndex = Math.max(
					0,
					Math.min(
						Math.max(0, this.state.filteredRows.length - 1),
						this.state.selectedModelIndex + direction * this.visibleRows,
					),
				);
			} else {
				this.selectGateway(direction * this.visibleRows);
			}
			return true;
		}

		if (matchesKey(data, Key.left)) {
			this.state.activePane = "gateways";
			return true;
		}

		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.state.activePane = "models";
			return true;
		}

		// Space: toggle model
		if (matchesKey(data, Key.space) && this.state.activePane === "models") {
			const row = this.state.filteredRows[this.state.selectedModelIndex];
			if (row) {
				row.enabled = !row.enabled;
				const entry = this.config.providers[this.state.selectedGateway];
				if (entry) {
					if (row.enabled) {
						if (!entry.enabledModels.includes(row.id)) entry.enabledModels.push(row.id);
					} else {
						entry.enabledModels = entry.enabledModels.filter(id => id !== row.id);
					}
				}
			}
			return true;
		}

		// t: test selected model
		if (data === "t" && this.state.activePane === "models") {
			const row = this.state.filteredRows[this.state.selectedModelIndex];
			if (row) await this.testModels([row.id]);
			return true;
		}

		// T: test all visible models
		if (data === "T") {
			const modelIds = this.state.filteredRows.map(r => r.id);
			if (modelIds.length > 0) await this.testModels(modelIds);
			return true;
		}

		// /: filter
		if (data === "/") {
			this.state.isFiltering = true;
			return true;
		}

		// s: cycle sort mode
		if (data === "s") {
			const modes: SortMode[] = ["name", "status", "performance", "enabled"];
			const currentIndex = modes.indexOf(this.state.sortMode);
			this.state.sortMode = modes[(currentIndex + 1) % modes.length];
			this.applyFiltersAndSort();
			return true;
		}

		// q: cycle quality filter
		if (data === "q") {
			const modes: QualityFilter[] = ["all", "recommended", "strict"];
			const currentIndex = modes.indexOf(this.state.qualityFilter);
			this.state.qualityFilter = modes[(currentIndex + 1) % modes.length];
			this.applyFiltersAndSort();
			return true;
		}

		// r: refresh (re-discover)
		if (data === "r") {
			await this.refreshModels();
			return true;
		}

		// a: auto-select recommended models
		if (data === "a") {
			await this.autoSelectModels();
			return true;
		}

		// u: undo last operation
		if (data === "u") {
			this.undoLastOperation();
			return true;
		}

		// d / dd: dedup (models pane) or delete gateway (gateways pane, vim-style dd)
		if (data === "d") {
			if (this.state.activePane === "gateways" && this.state.selectedGateway) {
				if (this.lastKey === "d") {
					// Second d → delete provider
					this.confirmDelete = this.state.selectedGateway;
					this.lastKey = "";
				} else {
					this.lastKey = "d";
				}
				return true;
			}
			await this.dedupModels();
			this.lastKey = "";
			return true;
		}

		// c: compare model across gateways
		if (data === "c" && this.state.activePane === "models") {
			await this.compareModel();
			return true;
		}

		// p: cycle the selected model's API (endpoint protocol)
		if (data === "p" && this.state.activePane === "models") {
			this.cycleModelApi();
			return true;
		}

		// g / b: toggle thinking / reasoning
		if ((data === "g" || data === "b") && this.state.activePane === "models") {
			this.toggleModelReasoning();
			return true;
		}

		// e/x: enable/disable by pattern (typed in-component)
		if (data === "e" || data === "x") {
			if (!this.state.selectedGateway) return true;
			this.pattern = { kind: data === "e" ? "enable" : "disable", input: new TextInput() };
			this.state.mode = "pattern";
			return true;
		}

		// R: refresh all gateways
		if (data === "R") {
			await this.refreshAllGateways();
			return true;
		}

		// A: test all gateways
		if (data === "A") {
			await this.testAllGateways();
			return true;
		}

		// n: add provider
		if (data === "n") {
			this.openAddForm();
			return true;
		}

		// D: delete selected provider (immediate, with confirmation)
		if (data === "D" && this.state.activePane === "gateways" && this.state.selectedGateway) {
			this.confirmDelete = this.state.selectedGateway;
			this.lastKey = "";
			return true;
		}
		this.lastKey = data;

		// ?: show help
		if (data === "?") {
			this.state.mode = "help";
			return true;
		}

		// Enter: save and exit
		if (matchesKey(data, Key.enter)) {
			this.save();
			this.saved = true;
			return false;
		}

		// Escape: cancel without saving
		if (matchesKey(data, Key.escape)) {
			this.cancel();
			this.saved = false;
			return false;
		}

		return true;
	}

	private handleFormInput(data: string): boolean {
		const f = this.form;
		if (!f) return true;

		if (matchesKey(data, Key.escape)) {
			this.form = null;
			this.state.mode = "browse";
			return true;
		}

		// API field: ←→ cycles, Enter submits.
		if (f.fieldIndex === 3) {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
				const direction = matchesKey(data, Key.right) ? 1 : -1;
				f.apiIndex = (f.apiIndex + direction + API_CHOICES.length) % API_CHOICES.length;
				return true;
			}
			if (matchesKey(data, Key.up)) {
				f.fieldIndex = 2;
				return true;
			}
			if (matchesKey(data, Key.enter)) {
				void this.submitForm();
				return true;
			}
			return true;
		}

		// Text fields: Enter/↓/Tab advances, ↑ goes back.
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
			f.fieldIndex = Math.min(3, f.fieldIndex + 1);
			if (f.fieldIndex === 3) void this.detectApiForForm();
			return true;
		}
		if (matchesKey(data, Key.up)) {
			f.fieldIndex = Math.max(0, f.fieldIndex - 1);
			return true;
		}
		f.fields[f.fieldIndex].handleInput(data);
		return true;
	}

	private handlePatternInput(data: string): boolean {
		const p = this.pattern;
		if (!p) return true;
		const action = p.input.handleInput(data);
		if (action === "submit") {
			this.applyPattern(p.input.value.trim(), p.kind === "enable");
			this.pattern = null;
			this.state.mode = "browse";
		} else if (action === "cancel") {
			this.pattern = null;
			this.state.mode = "browse";
		}
		return true;
	}

	private handleConfirmInput(data: string): boolean {
		if (data === "D" || data === "d" || matchesKey(data, Key.enter)) {
			const name = this.confirmDelete;
			this.confirmDelete = null;
			if (name) this.deleteProvider(name);
		} else if (matchesKey(data, Key.escape)) {
			this.confirmDelete = null;
		}
		return true;
	}

	// ---- undo/redo support ----

	private recordOperation(
		type: "toggle-model" | "enable-pattern" | "disable-pattern" | "auto-select" | "dedup" | "invert" | "toggle-all" | "delete-provider" | "add-provider",
		gateway: string,
		description: string,
		previousState: string[],
		newState: string[]
	): void {
		const op: Operation = {
			type,
			timestamp: Date.now(),
			gateway,
			description,
			previousState: [...previousState],
			newState: [...newState],
		};
		this.operationHistory.push(op);
	}

	private undoLastOperation(): void {
		if (!this.operationHistory.canUndo()) {
			this.ctx.ui.notify("Nothing to undo", "info");
			return;
		}

		const op = this.operationHistory.undo();
		if (!op) return;

		// Apply the previous state
		const entry = this.config.providers[op.gateway];
		if (entry) {
			entry.enabledModels = [...op.previousState];
			this.loadModels();
			this.ctx.ui.notify(`Undone: ${op.description}`, "info");
		} else {
			this.ctx.ui.notify(`Cannot undo: gateway "${op.gateway}" not found`, "error");
		}
	}

	// ---- main entry ----

	async run(): Promise<boolean> {
		if (this.ctx.mode !== "tui") {
			this.ctx.ui.notify("ai-manager requires TUI mode", "error");
			return false;
		}

		const result = await this.ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
			return {
				render: (width: number) => this.render(width, terminalHeight(), theme),
				invalidate: () => {},
				handleInput: async (data: string) => {
					const shouldContinue = await this.handleInput(data);
					if (!shouldContinue) {
						// Report what actually happened; Esc must not claim a save.
						done(this.saved);
					} else {
						tui.requestRender();
					}
				},
			};
		});
		return result ?? false;
	}
}
