// ---------------------------------------------------------------------------
// Advanced TUI Interface — Interactive Model Manager for ai-gateway
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { matchesGlob, parseContextWindow, validateName } from "./utils.ts";
import type {
	RelayConfig,
	RelayProviderEntry,
	RelayModelMeta,
	TestResult,
	FilterMode,
	QualityFilter,
	SortMode,
	RelayApi,
} from "./types.ts";
import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_REQUEST_DELAY_MS, DEFAULT_TEST_QUESTIONS, SUPPORTED_APIS, TEST_QUESTIONS_PER_MODEL, HEALTH_TTL_MS } from "./types.ts";
import { scoreModel, filterModels } from "./model-scoring.ts";
import { canonicalBaseUrl, cloneConfig, commitConfig, readCurrentConfig } from "./config.ts";
import { isEnvName, safeDisplay, safeError } from "./security.ts";
import { RateLimiter, compileOverrides, fetchModelList, type DiscoveredModel } from "./network.ts";
import { registerProviderFor, applyDiscovery, modelLimits, modelReasoning, providerApiKey, hasProviderAuth } from "./provider.ts";
import { testModelsInParallel, testModel as testModelFn, pickQuestions, applyTestResultToMeta } from "./testing.ts";
import { normalizeModelName, findDuplicateModels, compareInstances } from "./dedup.ts";
import { detectDefaultApi } from "./api-detect.ts";
import { TextInput } from "./tui-input.ts";
import { OperationHistory, type Operation } from "./tui-state.ts";
import { beside, cell, fitHints, focusOffset, screen, screenSize, wrapLines, type ViewTheme, type ScreenSize } from "./tui-layout.ts";
import { effectiveHealth, modelDetails, modelHeader, modelLine, modelSettingsLines, recordTime, type ModelRow } from "./tui-models.ts";
import { summarizeDraft, type DraftSummary } from "./tui-draft.ts";
import { COMMANDS, MODEL_SETTING_COMMANDS, HELP_TEXT, FILTER_LABELS, QUALITY_LABELS, SORT_LABELS, browseFooter, commandForInput, commandHint, dialogFooter, type Command, type CommandId, type MenuItem } from "./tui-commands.ts";

// ---------------------------------------------------------------------------
// Local types for TUI state
// ---------------------------------------------------------------------------

type TuiMode = "browse" | "form" | "context" | "pattern" | "help" | "details" | "changes" | "compare" | "menu";

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
	editingName?: string;
}

interface ContextWindowForm {
	modelId: string;
	input: TextInput;
	status: string;
	returnMode: "browse" | "details";
}

interface GatewayView {
	modelId?: string;
	index: number;
	scroll: number;
}

interface MenuState {
	kind: "actions" | "filters";
	input: TextInput;
	index: number;
	offset: number;
}

const API_CHOICES: readonly RelayApi[] = [...SUPPORTED_APIS];
const DEFAULT_API_INDEX = API_CHOICES.indexOf("openai-completions");

/** States the `p` key cycles through for the selected model. "auto" = no pin, follow discovery. */
const API_CYCLE: readonly (RelayApi | "auto")[] = ["auto", "anthropic-messages", "openai-responses", "openai-completions"];

/** Exact-match regex rule key for a model id, used as a modelApiOverrides entry. */
function exactApiRule(modelId: string): string {
	return `^${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

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
	private baseline: RelayConfig;
	private readonly temporaryProviders = new Set<string>();
	private requestRender: () => void = () => {};
	private pendingTest: { gateway?: string; ids?: string[]; allGateways: boolean; count: number } | null = null;
	private readonly filterInput = new TextInput();
	private pattern: { kind: "enable" | "disable"; input: TextInput } | null = null;
	private form: AddProviderForm | null = null;
	private contextForm: ContextWindowForm | null = null;
	/** Gateway pending deletion confirmation. */
	private confirmDelete: string | null = null;
	/** An async form action is in flight; Escape still cancels it. */
	private busy = false;
	/** Tracks the last key for vim-style double-press (dd to delete). */
	private lastKey = "";
	/** Operation history for undo/redo functionality. */
	private operationHistory = new OperationHistory();
	private activeAbortController: AbortController | null = null;
	private isClosed = false;
	private helpOffset = 0;
	private panelOffset = 0;
	private panelLength = 0;
	private panelRows = 1;
	private panelContent: string[] = [];
	private formOffset = 0;
	private menu: MenuState | null = null;
	private menuRows = 1;
	private loadedGateway = "";
	private readonly gatewayViews = new Map<string, GatewayView>();
	private draftCache: DraftSummary | null = null;
	private readonly sessionResults = new Map<string, { result: TestResult; lastCheck?: number }>();
	private readonly testingModels = new Set<string>();
	private readonly sessionSecrets = new Set<string>();
	private taskLabel = "";
	private notice = "";
	private searchBefore = "";
	private searchSelection: GatewayView | undefined;
	private nextHealthExpiry = Infinity;

	private taskIsCurrent(controller: AbortController): boolean {
		return !this.isClosed && this.activeAbortController === controller && !controller.signal.aborted;
	}

	private restoreTemporaryProviders(): void {
		if (this.temporaryProviders.size === 0) return;
		let current: RelayConfig;
		try { current = readCurrentConfig(); }
		catch (error) {
			// Keep temporary models/keys out of the registry even if the file became unreadable.
			current = this.baseline;
			this.reportError(error);
		}
		for (const name of this.temporaryProviders) {
			const entry = current.providers[name];
			try {
				if (entry) registerProviderFor(this.pi, name, entry);
				else this.pi.unregisterProvider(name);
			} catch (error) {
				this.pi.unregisterProvider(name);
				this.reportError(error);
			}
		}
		this.temporaryProviders.clear();
	}

	private registerTemporary(name: string, entry: RelayProviderEntry, ids?: string[]): void {
		this.temporaryProviders.add(name);
		registerProviderFor(this.pi, name, entry, ids);
	}

	private abortActiveTasks(): void {
		const controller = this.activeAbortController;
		this.activeAbortController = null;
		controller?.abort();
		this.busy = false;
		this.state.testingInProgress = false;
		this.testingModels.clear();
		this.taskLabel = "";
		this.ctx.ui.setStatus("ai-manager", undefined);
		for (const row of this.state.modelRows) row.testing = false;
		try { this.restoreTemporaryProviders(); } catch (error) { this.reportError(error); }
	}

	private reportError(error: unknown): void {
		this.notice = safeError(error, this.secretValues());
		this.ctx.ui.notify(this.notice, "error");
	}

	private secretValues(): string[] {
		return [...this.sessionSecrets, ...[this.config, this.baseline].flatMap(config => Object.values(config.providers)
			.flatMap(entry => [entry.apiKey ?? "", entry.apiKeyEnv ? process.env[entry.apiKeyEnv] ?? "" : ""]))];
	}

	private stopTask(): void {
		if (!this.activeAbortController) return;
		const progress = this.state.testingInProgress ? `（已完成 ${this.state.testProgress.current}/${this.state.testProgress.total}）` : "";
		this.abortActiveTasks();
		this.notice = `任务已停止${progress}；草稿与已完成记录已保留。`;
		this.applyFiltersAndSort();
		this.requestRender();
	}

	private draftSummary(): DraftSummary {
		return this.draftCache ??= summarizeDraft(this.baseline, this.config);
	}

	private testKey(gateway: string, modelId: string): string { return JSON.stringify([gateway, modelId]); }

	private beginModelTest(gateway: string, modelId: string): void {
		this.testingModels.add(this.testKey(gateway, modelId));
		const row = this.state.selectedGateway === gateway ? this.state.modelRows.find(row => row.id === modelId) : undefined;
		if (row) row.testing = true;
		this.requestRender();
	}

	private recordTestResult(gateway: string, modelId: string, result: TestResult): void {
		const meta = this.config.providers[gateway]?.models[modelId];
		if (!meta) return;
		const safeResult = { ...result, reasons: result.reasons.map(reason => safeError(reason, this.secretValues())) };
		applyTestResultToMeta(meta, safeResult);
		this.sessionResults.set(this.testKey(gateway, modelId), { result: safeResult, lastCheck: meta.health?.lastCheck });
		this.testingModels.delete(this.testKey(gateway, modelId));
		const row = this.state.selectedGateway === gateway ? this.state.modelRows.find(row => row.id === modelId) : undefined;
		if (row) { row.testing = false; row.testResult = safeResult; row.meta = meta; }
		this.draftCache = null;
		this.applyFiltersAndSort();
	}

	private async runTask(operation: (controller: AbortController) => Promise<void>): Promise<void> {
		if (this.isClosed) return;
		this.abortActiveTasks();
		this.notice = "";
		const controller = new AbortController();
		this.activeAbortController = controller;
		try {
			const task = operation(controller);
			this.requestRender();
			await task;
		} catch (error) {
			if (this.taskIsCurrent(controller)) this.reportError(error);
		} finally {
			if (this.activeAbortController === controller) {
				this.activeAbortController = null;
				this.busy = false;
				this.state.testingInProgress = false;
				this.testingModels.clear();
				this.taskLabel = "";
				for (const row of this.state.modelRows) row.testing = false;
				try { this.restoreTemporaryProviders(); } catch (error) { this.reportError(error); }
				this.ctx.ui.setStatus("ai-manager", undefined);
				this.requestRender();
			}
		}
	}

	constructor(ctx: ExtensionCommandContext, pi: ExtensionAPI, config: RelayConfig, initialGateway?: string) {
		this.ctx = ctx;
		this.pi = pi;
		this.config = config;
		this.baseline = cloneConfig(config);

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
			sortMode: "enabled",
			qualityFilter: "all",
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
		this.draftCache = null;
		let selectedId: string | undefined = this.state.filteredRows[this.state.selectedModelIndex]?.id;
		if (this.loadedGateway !== this.state.selectedGateway) {
			this.rememberModelView();
			const view = this.gatewayViews.get(this.state.selectedGateway);
			this.state.selectedModelIndex = view?.index ?? 0;
			this.state.scrollOffset = view?.scroll ?? 0;
			selectedId = view?.modelId;
			this.loadedGateway = this.state.selectedGateway;
		}
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) {
			this.state.modelRows = [];
			this.state.filteredRows = [];
			this.state.selectedModelIndex = 0;
			this.state.scrollOffset = 0;
			return;
		}

		const enabledSet = new Set(entry.enabledModels);
		this.state.modelRows = Object.entries(entry.models).map(([id, meta]) => {
			const key = this.testKey(this.state.selectedGateway, id);
			const previous = this.sessionResults.get(key);
			return {
				id, enabled: enabledSet.has(id), testing: this.testingModels.has(key), meta, qualityScore: scoreModel(id),
				testResult: previous?.lastCheck === meta.health?.lastCheck ? previous?.result : undefined,
			};
		});

		this.applyFiltersAndSort(selectedId ?? "");
	}

	private rememberModelView(): void {
		if (!this.loadedGateway) return;
		this.gatewayViews.set(this.loadedGateway, {
			modelId: this.state.filteredRows[this.state.selectedModelIndex]?.id ?? this.gatewayViews.get(this.loadedGateway)?.modelId,
			index: this.state.selectedModelIndex, scroll: this.state.scrollOffset,
		});
	}

	private applyFiltersAndSort(selectedId = this.state.filteredRows[this.state.selectedModelIndex]?.id): void {
		const now = Date.now();
		this.nextHealthExpiry = this.state.modelRows.reduce((expiry, row) => {
			const next = row.meta.health?.lastCheck ? row.meta.health.lastCheck + HEALTH_TTL_MS + 1 : Infinity;
			return next > now ? Math.min(expiry, next) : expiry;
		}, Infinity);
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
				filtered = filtered.filter(row => effectiveHealth(row.meta.health, now) === "healthy");
				break;
			case "untested":
				filtered = filtered.filter(row => effectiveHealth(row.meta.health, now) === "unknown");
				break;
		}

		// Sort
		filtered.sort((a, b) => {
			switch (this.state.sortMode) {
				case "name":
					return a.id.localeCompare(b.id);
				case "status": {
					const statusOrder = { healthy: 0, degraded: 1, down: 2, unknown: 3 };
					const aStatus = effectiveHealth(a.meta.health, now);
					const bStatus = effectiveHealth(b.meta.health, now);
					const statusCmp = statusOrder[aStatus] - statusOrder[bStatus];
					if (statusCmp !== 0) return statusCmp;
					return a.id.localeCompare(b.id);
				}
				case "performance": {
					const aTime = ["healthy", "degraded"].includes(effectiveHealth(a.meta.health, now)) ? a.meta.metrics?.avgResponseTime ?? Infinity : Infinity;
					const bTime = ["healthy", "degraded"].includes(effectiveHealth(b.meta.health, now)) ? b.meta.metrics?.avgResponseTime ?? Infinity : Infinity;
					return (aTime === bTime ? 0 : aTime - bTime) || a.id.localeCompare(b.id);
				}
				case "enabled":
					if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
					return a.id.localeCompare(b.id);
				default:
					return 0;
			}
		});

		this.state.filteredRows = filtered;

		const index = selectedId ? filtered.findIndex(row => row.id === selectedId) : -1;
		this.state.selectedModelIndex = index >= 0 ? index : Math.max(0, Math.min(this.state.selectedModelIndex, filtered.length - 1));
		this.clampScroll();
		this.rememberModelView();
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


	/** Undo edited fields while retaining metadata learned by later discovery. */
	private recordModelEdit(gateway: string, modelId: string, description: string, fields: readonly (keyof RelayModelMeta)[], overrideKey?: string): void {
		const meta = this.config.providers[gateway]?.models[modelId];
		if (!meta) return;
		const before = JSON.parse(JSON.stringify(meta)) as RelayModelMeta;
		const previousOverrides = overrideKey ? { ...this.config.providers[gateway].modelApiOverrides } : undefined;
		this.operationHistory.record({ gateway, description, undo: () => {
			const entry = this.config.providers[gateway];
			if (!entry?.models[modelId]) return;
			const current = entry.models[modelId];
			const values = current as unknown as Record<string, unknown>;
			for (const field of fields) {
				if (Object.hasOwn(before, field)) values[field] = before[field];
				else delete values[field];
			}
			if (overrideKey && previousOverrides) {
				// First matching rule wins, so undo must restore the original order too.
				entry.modelApiOverrides = { ...previousOverrides };
				if (!previousOverrides[overrideKey]) current.api = current.discoveredApi ?? before.api;
			}
		} });
	}

	/** Cycle an exact model pin; auto removes it and resumes gateway rules / discovery. */
	private cycleModelApi(): void {
		const gateway = this.state.selectedGateway;
		const entry = this.config.providers[gateway];
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!entry || !row) return;
		const ruleKey = exactApiRule(row.id);
		const current = entry.modelApiOverrides?.[ruleKey] ?? "auto";
		const next = API_CYCLE[(API_CYCLE.indexOf(current) + 1) % API_CYCLE.length];
		this.recordModelEdit(gateway, row.id, `Change API for ${row.id}`, ["api"], ruleKey);
		const others = Object.fromEntries(Object.entries(entry.modelApiOverrides ?? {}).filter(([key]) => key !== ruleKey));
		entry.modelApiOverrides = next === "auto" ? others : { [ruleKey]: next, ...others };
		entry.models[row.id].api = next === "auto" ? entry.models[row.id].discoveredApi ?? entry.defaultApi : next;
		this.loadModels();
	}

	private toggleModelReasoning(): void {
		const gateway = this.state.selectedGateway;
		const entry = this.config.providers[gateway];
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!entry || !row) return;
		this.recordModelEdit(gateway, row.id, `Toggle reasoning for ${row.id}`, ["reasoning"]);
		const meta = entry.models[row.id];
		meta.reasoning = !modelReasoning(entry, row.id);
		this.loadModels();
		this.ctx.ui.notify(`Reasoning ${meta.reasoning ? "enabled" : "disabled"} for ${row.id}`, "info");
	}

	// ---- rendering ----

	render(width: number, height: number, theme: ViewTheme): string[] {
		if (Date.now() >= this.nextHealthExpiry) this.applyFiltersAndSort();
		const size = screenSize(width, height);
		const summary = this.draftSummary();
		const dirty = summary.total ? "未保存：" + summary.total + " 项" : "已保存";
		const titles: Partial<Record<TuiMode, string>> = {
			help: "快捷键帮助", details: "详情", changes: "未保存变更", compare: "网关比较",
			menu: this.menu?.kind === "filters" ? "筛选模型" : "操作菜单",
			form: this.form?.editingName ? "编辑网关" : "新增网关", context: "设置上下文", pattern: "批量选择",
		};
		const title = beside(titles[this.state.mode] ?? "AI Manager", dirty, size.width);
		let body: string[];
		let footer = browseFooter(size.width, this.state.activePane, !!this.activeAbortController);
		const backFooter = [
			fitHints(["↑↓ / PgUp PgDn 滚动", ...(this.activeAbortController ? ["Ctrl+C 停止任务"] : [])], size.width),
			fitHints(["Esc 返回", ": 操作菜单"], size.width),
		];
		if (["help", "details", "changes", "compare"].includes(this.state.mode)) {
			const lines = this.state.mode === "help" ? HELP_TEXT
				: this.state.mode === "details" ? this.detailLines()
				: this.state.mode === "changes" ? this.changeLines()
				: this.panelContent;
			body = this.renderPanel(lines, size);
			footer = backFooter;
			if (this.state.mode === "details" && this.state.activePane === "models") {
				footer = [fitHints(this.activeAbortController
					? ["Ctrl+C 停止任务", "设置暂不可改", "↑↓ 滚动"]
					: [...MODEL_SETTING_COMMANDS.map(commandHint), "↑↓ 滚动"], size.width), backFooter[1]];
			}
		} else if (this.menu) {
			body = this.renderMenu(size, theme);
			footer = [fitHints(["输入名称或按键搜索", "↑↓ 选择", ...(this.activeAbortController ? ["Ctrl+C 停止"] : [])], size.width), dialogFooter(size.width, "选择", "返回")];
		} else if (this.state.mode === "form" && this.form) {
			body = this.renderForm(theme, size);
			footer = [fitHints(["Tab/Shift+Tab 切字段", "←→ 编辑 / 选择 API", "Ctrl+U 清空"], size.width),
				this.busy ? "Esc 取消发现及表单" : dialogFooter(size.width, this.form.fieldIndex === 3 ? "应用" : "下一项")];
		} else if (this.state.mode === "context" && this.contextForm) {
			const f = this.contextForm;
			const entry = this.config.providers[this.state.selectedGateway];
			const limits = entry ? modelLimits(entry, f.modelId) : undefined;
			const label = size.width >= 20 ? "新长度: " : "";
			body = [label + f.input.render(theme, size.width - visibleWidth(label)),
				...wrapLines([
					...(f.status ? [f.status] : []),
					...(limits ? [`当前长度：${limits.contextWindow.toLocaleString("en-US")} tokens${limits.estimated ? "（估算）" : ""}`] : []),
					"空值清除手工设置；支持 128k、256000、1m。", "模型：" + safeDisplay(f.modelId),
				], size.width)];
			footer = ["修改只加入草稿", dialogFooter(size.width, "应用")];
		} else if (this.state.mode === "pattern" && this.pattern) {
			const label = this.pattern.kind === "enable" ? "启用: " : "禁用: ";
			body = [label + this.pattern.input.render(theme, Math.max(1, size.width - visibleWidth(label))),
				...wrapLines(["作用于当前网关的所有模型。支持 * 和 ?，例如 gpt-*。"], size.width)];
			footer = ["修改只加入草稿", dialogFooter(size.width, "应用")];
		} else if (this.pendingTest) {
			const pending = this.pendingTest;
			const requests = pending.count * Math.min(this.testQuestions().length, TEST_QUESTIONS_PER_MODEL);
			body = this.renderPanel([
				pending.count + " models, " + requests + " requests, up to " + requests * 256 + " output tokens.",
				"批量测试可能收费，价格可能未知；不含输入 token 和网关额外计费。",
				pending.allGateways ? "范围：所有网关已启用模型。" : "范围：" + pending.gateway + "，筛选后的模型（含未启用）。",
			], size);
			footer = ["↑↓ 滚动查看范围", dialogFooter(size.width, "开始测试")];
		} else if (this.confirmDelete) {
			const entry = this.config.providers[this.confirmDelete];
			body = this.renderPanel(["删除网关：" + this.confirmDelete,
				"将移除 " + (entry?.enabledModels.length ?? 0) + " 个已启用模型。修改先加入草稿，u 可撤销。"], size);
			footer = ["确认后仍需在主界面保存", dialogFooter(size.width, "确认删除")];
		} else {
			body = this.renderBrowse(size, theme);
			if (this.state.isFiltering) footer = [
				fitHints(["←→ 移动光标", "Home/End 首尾", "Ctrl+U 清空", ...(this.activeAbortController ? ["Ctrl+C 停止"] : [])], size.width),
				dialogFooter(size.width, "保留搜索", "还原"),
			];
		}
		return screen(size, title, body, footer, theme);
	}

	private renderPanel(lines: readonly string[], size: ScreenSize): string[] {
		const wrapped = wrapLines(lines, size.width);
		this.panelLength = wrapped.length;
		this.panelRows = Math.max(1, size.bodyRows);
		const offset = this.state.mode === "help" ? this.helpOffset : this.panelOffset;
		const clamped = Math.max(0, Math.min(offset, wrapped.length - this.panelRows));
		if (this.state.mode === "help") this.helpOffset = clamped;
		else this.panelOffset = clamped;
		return wrapped.slice(clamped, clamped + size.bodyRows);
	}

	private detailLines(): string[] {
		const gateway = this.state.selectedGateway;
		const entry = this.config.providers[gateway];
		if (!entry) return ["没有选中网关；n 新增网关。"];
		const selected = this.state.filteredRows[this.state.selectedModelIndex];
		if (this.state.activePane === "models") return selected ? modelDetails(gateway, entry, selected, this.secretValues()) : ["没有匹配的模型；f 调整筛选。"];
		const auth = this.ctx.modelRegistry.getProviderAuthStatus(gateway);
		const source = auth.source === "runtime" ? "Pi 运行时凭据" : auth.source === "stored" ? "Pi 登录凭据"
			: entry.apiKeyEnv ? "环境变量引用" : entry.apiKey ? "配置中的密钥" : "Pi 凭据";
		return [
			"网关：" + safeDisplay(gateway),
			"连接地址：" + safeDisplay(entry.baseUrl),
			"默认协议：" + entry.defaultApi,
			"凭据：" + (hasProviderAuth(this.ctx, gateway, entry) ? "已配置" : "未配置") + "；来源：" + source,
			"凭据已配置只表示存在凭据，不代表已验证连通性。",
			"模型：已启用 " + entry.enabledModels.length + " / 共 " + Object.keys(entry.models).length,
		];
	}

	private changeLines(): string[] {
		const summary = this.draftSummary();
		if (!summary.total) return ["没有未保存的更改。"];
		return [
			"配置 " + summary.config + " 项；测试 " + summary.test + " 项；发现 " + summary.discovery + " 项。",
			"Enter / Ctrl+S 在主界面保存全部草稿；u 撤销最近的配置操作。",
			...(["config", "test", "discovery"] as const).flatMap(kind => summary.changes.filter(change => change.kind === kind)
				.map(change => "[" + ({ config: "配置", test: "测试", discovery: "发现" }[kind]) + "] " + change.text)),
		];
	}

	private gatewayLine(name: string | undefined, width: number, theme: ViewTheme): string {
		if (!name) return "";
		const entry = this.config.providers[name];
		const selected = name === this.state.selectedGateway;
		const label = (selected ? "> " : "  ") + safeDisplay(name);
		const counts = entry.enabledModels.length + "/" + Object.keys(entry.models).length;
		return beside(selected && this.state.activePane === "gateways" ? theme.bold(label) : label, counts, width);
	}

	private renderBrowse(size: ScreenSize, theme: ViewTheme): string[] {
		const { width: w, bodyRows } = size;
		const lines: string[] = [];
		const gateways = Object.keys(this.config.providers);
		const entry = this.config.providers[this.state.selectedGateway];
		const total = this.state.modelRows.length;
		const matched = this.state.filteredRows.length;
		const selected = this.state.filteredRows[this.state.selectedModelIndex];
		const apiRules = compileOverrides(entry?.modelApiOverrides ?? {});
		const settings = this.state.activePane === "models" && entry && selected && !this.state.isFiltering && w >= 20 && bodyRows >= 5
			? modelSettingsLines(entry, selected, w, apiRules) : [];
		const listRows = bodyRows - settings.length;
		const dual = w >= 90;
		const leftWidth = dual ? Math.min(26, Math.floor(w / 4)) : w;
		const rightWidth = dual ? w - leftWidth - 3 : w;
		const pair = (left: string, right: string) => dual
			? cell(left, leftWidth) + theme.fg("accent", " │ ") + cell(right, rightWidth)
			: cell(this.state.activePane === "gateways" ? left : right, w);
		const search = () => {
			const label = w >= 20 ? "搜索: " : "/";
			return label + this.filterInput.render(theme, w - visibleWidth(label));
		};
		if (this.state.isFiltering && bodyRows <= 1) return [search()];
		if (listRows >= 3) {
			lines.push(beside((this.state.activePane === "models" ? "模型 · " : "网关 · ") + (this.state.selectedGateway || "未配置"),
				"显示 " + matched + "/" + total + " · 启用 " + (entry?.enabledModels.length ?? 0), w));
		}
		if (listRows >= 5 || this.state.isFiltering) {
			lines.push(this.state.isFiltering ? search() : cell("f 筛选:" + FILTER_LABELS[this.state.filterMode] +
				"  q 质量:" + QUALITY_LABELS[this.state.qualityFilter] + "  s 排序:" + SORT_LABELS[this.state.sortMode] +
				(this.filterInput.value ? "  / " + this.filterInput.value : ""), w));
		}
		const progress = this.state.testingInProgress ? " " + this.state.testProgress.current + "/" + this.state.testProgress.total : "";
		const status = this.activeAbortController ? this.taskLabel + progress + " · Ctrl+C 停止" : this.notice;
		if (status && listRows - lines.length >= 3) lines.push(theme.fg("warning", cell(status, w)));
		if (listRows - lines.length >= 2) lines.push(pair(
			(this.state.activePane === "gateways" ? "> " : "  ") + "网关 · 启用/总数",
			modelHeader(rightWidth),
		));
		this.visibleRows = Math.max(1, listRows - lines.length);
		this.clampScroll();
		this.clampGatewayScroll();
		for (let i = 0; i < this.visibleRows; i++) {
			const gateway = gateways[this.state.gatewayScrollOffset + i];
			const index = this.state.scrollOffset + i;
			const row = this.state.filteredRows[index];
			const left = this.gatewayLine(gateway, leftWidth, theme) || (i === 0 && !gateways.length ? "n 新增网关" : "");
			const right = row ? modelLine(row, entry, this.state.activePane === "models" && index === this.state.selectedModelIndex, rightWidth, theme, apiRules)
				: i === 0 && !matched ? (total ? "没有匹配模型 · f 重置筛选" : "没有模型 · r 发现 / n 新增") : "";
			lines.push(pair(left, right));
		}
		lines.push(...settings);
		this.rememberModelView();
		return lines;
	}

	private renderForm(theme: ViewTheme, size: ScreenSize): string[] {
		const f = this.form!;
		const labels = size.width >= 32 ? ["名称: ", "地址: ", "密钥: "] : size.width >= 12 ? ["名:", "址:", "钥:"] : ["", "", ""];
		const fields = f.fields.map((field, index) => {
			const label = labels[index];
			const width = Math.max(0, size.width - visibleWidth(label));
			const shown = index === f.fieldIndex ? field.render(theme, width)
				: theme.fg("dim", truncateToWidth(index === 2 ? "*".repeat(field.value.length) : field.value, width, "…"));
			return (index === f.fieldIndex ? theme.fg("accent", label) : label) + shown;
		});
		fields.push((f.fieldIndex === 3 ? "> API: " : "  API: ") + API_CHOICES[f.apiIndex]);
		const status = wrapLines([f.status || "在 API 字段按 Enter 将更改加入草稿。"], size.width);
		const statusRows = size.bodyRows >= 2 ? Math.min(status.length, Math.max(1, size.bodyRows - 4)) : 0;
		const fieldRows = Math.max(1, size.bodyRows - statusRows);
		this.formOffset = focusOffset(f.fieldIndex, this.formOffset, fields.length, fieldRows);
		const lines = fields.slice(this.formOffset, this.formOffset + fieldRows);
		while (lines.length < fieldRows) lines.push("");
		const color = f.statusKind === "error" ? "error" : f.statusKind === "warning" ? "warning" : "dim";
		lines.push(...status.slice(0, statusRows).map(line => theme.fg(color, line)));
		return lines;
	}

	private commandBlocked(command: Command): string | undefined {
		if (this.activeAbortController && !command.readOnly) return "任务进行中，请先停止";
		if (command.pane && this.state.activePane !== command.pane) return "请先切换到" + (command.pane === "models" ? "模型栏" : "网关栏");
		if (command.needs === "gateway" && !this.config.providers[this.state.selectedGateway]) return "没有选中网关";
		if (command.needs === "model" && !this.state.filteredRows[this.state.selectedModelIndex]) return "没有选中模型";
		if (command.needs === "history" && !this.operationHistory.canUndo()) return "没有可撤销的操作";
		if (command.needs === "task" && !this.activeAbortController) return "没有进行中的任务";
		return undefined;
	}

	private menuItems(): MenuItem[] {
		if (!this.menu) return [];
		const query = this.menu.input.value.toLowerCase();
		const items: MenuItem[] = this.menu.kind === "actions"
			? (COMMANDS as readonly Command[]).filter(command => command.id !== "actions").map(command => {
				const reason = this.commandBlocked(command);
				return { id: command.id, label: command.label, hint: reason ?? command.keyHint, enabled: !reason };
			})
			: [
				...Object.entries(FILTER_LABELS).map(([mode, label]) => ({ id: "filter:" + mode, label: "状态 · " + label, hint: "", enabled: true, checked: this.state.filterMode === mode })),
				...Object.entries(QUALITY_LABELS).map(([mode, label]) => ({ id: "quality:" + mode, label: "质量 · " + label, hint: "", enabled: true, checked: this.state.qualityFilter === mode })),
				{ id: "reset", label: "重置所有筛选和搜索", hint: "", enabled: true },
			];
		return items.filter(item => (item.label + " " + item.id + " " + item.hint).toLowerCase().includes(query));
	}

	private renderMenu(size: ScreenSize, theme: ViewTheme): string[] {
		const menu = this.menu!;
		const items = this.menuItems();
		menu.index = Math.max(0, Math.min(menu.index, items.length - 1));
		this.menuRows = Math.max(1, size.bodyRows - 1);
		menu.offset = focusOffset(menu.index, menu.offset, items.length, this.menuRows);
		const label = size.width >= 20 ? "查找: " : "/";
		const lines = [label + menu.input.render(theme, size.width - visibleWidth(label))];
		if (size.bodyRows <= 1) return [items[menu.index] ? "> " + items[menu.index].label : "没有匹配操作"];
		for (let i = menu.offset; i < Math.min(items.length, menu.offset + this.menuRows); i++) {
			const item = items[i];
			const prefix = (i === menu.index ? "> " : "  ") + (item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ");
			const line = beside(prefix + item.label, item.hint, size.width);
			lines.push(item.enabled ? i === menu.index ? theme.fg("accent", line) : line : theme.fg("dim", line));
		}
		if (!items.length) lines.push("没有匹配操作；Ctrl+U 清空搜索");
		return lines;
	}

	private selectGateway(offset: number): void {
		const gateways = Object.keys(this.config.providers);
		if (gateways.length === 0) return;
		const currentIndex = Math.max(0, gateways.indexOf(this.state.selectedGateway));
		const nextIndex = Math.max(0, Math.min(gateways.length - 1, currentIndex + offset));
		const nextGateway = gateways[nextIndex];
		if (!nextGateway || nextGateway === this.state.selectedGateway) return;
		this.state.selectedGateway = nextGateway;
		this.loadModels();
	}

	private async testModels(modelIds: string[], gateway = this.state.selectedGateway): Promise<void> {
		const entry = this.config.providers[gateway];
		if (!entry) return;
		await this.runTask(async controller => {
			this.state.testingInProgress = true;
			this.state.testProgress = { current: 0, total: modelIds.length };
			this.taskLabel = `测试 ${gateway}`;
			const key = await providerApiKey(this.ctx, gateway, entry);
			if (!this.taskIsCurrent(controller)) return;
			if (key) this.sessionSecrets.add(key);
			const questions = this.testQuestions();
			const rateLimiter = new RateLimiter(this.config.settings.testRequestDelayMs ?? DEFAULT_TEST_REQUEST_DELAY_MS);
			this.registerTemporary(gateway, entry, [...new Set([...entry.enabledModels, ...modelIds])]);
			let completed = 0;
			await testModelsInParallel(
				this.ctx, gateway, modelIds, questions,
				this.config.settings.testConcurrency ?? DEFAULT_TEST_CONCURRENCY,
				rateLimiter,
				(modelId) => {
					if (!this.taskIsCurrent(controller)) return;
					this.beginModelTest(gateway, modelId);
				}, controller.signal,
				(modelId, result) => {
					if (!this.taskIsCurrent(controller)) return;
					this.recordTestResult(gateway, modelId, result);
					this.state.testProgress = { current: ++completed, total: modelIds.length };
					this.requestRender();
				},
				this.secretValues(),
			);
			if (this.taskIsCurrent(controller)) this.applyFiltersAndSort();
		});
	}

	private testQuestions(): string[] {
		return this.config.settings.testQuestions?.length ? this.config.settings.testQuestions : [...DEFAULT_TEST_QUESTIONS];
	}

	private async refreshModels(): Promise<void> {
		const gateway = this.state.selectedGateway;
		const entry = this.config.providers[gateway];
		if (!entry) return;
		await this.runTask(async controller => {
			this.taskLabel = `发现 ${gateway}`;
			this.ctx.ui.setStatus("ai-manager", `Discovering ${gateway}…`);
			const key = await providerApiKey(this.ctx, gateway, entry);
			if (!this.taskIsCurrent(controller)) return;
			const list = await fetchModelList(entry.baseUrl, key, { signal: controller.signal, allowInsecureHttp: entry.allowInsecureHttp });
			if (!this.taskIsCurrent(controller)) return;
			applyDiscovery(entry, list);
			this.draftCache = null;
			if (this.state.selectedGateway === gateway) this.loadModels();
			this.notice = `已发现 ${gateway} 的 ${list.length} 个模型；Enter 保存草稿。`;
			this.ctx.ui.notify(`Discovered ${list.length} models for ${gateway}. Enter saves the draft.`, "info");
		});
	}

	private save(): boolean {
		try {
			// Validate registration before committing files. Restore persisted providers on failure.
			for (const [name, entry] of Object.entries(this.config.providers)) this.registerTemporary(name, entry);
			const merged = commitConfig(this.baseline, this.config);
			const previousNames = new Set([...Object.keys(this.baseline.providers), ...this.temporaryProviders]);
			this.config = merged;
			this.baseline = cloneConfig(merged);
			this.draftCache = null;
			for (const name of previousNames) {
				if (!merged.providers[name]) this.pi.unregisterProvider(name);
			}
			for (const [name, entry] of Object.entries(merged.providers)) registerProviderFor(this.pi, name, entry);
			this.temporaryProviders.clear();
			return true;
		} catch (error) {
			this.reportError(error);
			try { this.restoreTemporaryProviders(); } catch (restoreError) { this.reportError(restoreError); }
			return false;
		}
	}

	/** Discard the draft; cancellation never writes an old snapshot to disk. */
	private cancel(): void {
		this.abortActiveTasks();
		this.config = cloneConfig(this.baseline);
		this.draftCache = null;
		this.operationHistory.clear();
	}

	// ---- batch actions ----

	private async autoSelectModels(): Promise<void> {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry) return;

		const previousState = [...entry.enabledModels];

		const allModelIds = Object.keys(entry.models);
		const recommended = allModelIds.filter(id => {
			const score = scoreModel(id);
			return score.recommendScore >= 60 && !score.isGarbage && entry.models[id].health?.status !== "down";
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

	private compareModel(): void {
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!row) return;
		const lines = [`模型：${row.id}`, "仅比较已有记录，不发送新请求。"];
		for (const [gateway, entry] of Object.entries(this.config.providers)) {
			for (const [id, meta] of Object.entries(entry.models)) {
				if (normalizeModelName(id) !== normalizeModelName(row.id)) continue;
				const status = effectiveHealth(meta.health);
				lines.push(`${safeDisplay(gateway)} / ${safeDisplay(id)}：${status}，成功延迟 ${meta.metrics?.avgResponseTime ?? "—"}ms；${recordTime(meta.health?.lastCheck)}`);
			}
		}
		this.panelContent = lines;
		this.panelOffset = 0;
		this.state.mode = "compare";
	}

	private applyPattern(pattern: string, enable: boolean): void {
		const entry = this.config.providers[this.state.selectedGateway];
		if (!entry || !pattern) return;

		const previousState = [...entry.enabledModels];

		if (enable) {
			const enabledSet = new Set(entry.enabledModels);
			const matches = Object.keys(entry.models).filter(id => matchesGlob(id, pattern));
			for (const modelId of matches) {
				if (!enabledSet.has(modelId)) {
					entry.enabledModels.push(modelId);
					enabledSet.add(modelId);
				}
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
			const matchSet = new Set(entry.enabledModels.filter(id => matchesGlob(id, pattern)));
			entry.enabledModels = entry.enabledModels.filter(id => !matchSet.has(id));

			// Record operation for undo
			if (matchSet.size > 0) {
				this.recordOperation(
					"disable-pattern",
					this.state.selectedGateway,
					`Disabled ${matchSet.size} models matching "${pattern}"`,
					previousState,
					entry.enabledModels
				);
			}

			this.loadModels();
			this.ctx.ui.notify(`Disabled ${matchSet.size} model(s) matching "${pattern}"`, "info");
		}
	}

	private async refreshAllGateways(): Promise<void> {
		await this.runTask(async controller => {
			let successful = 0;
			const entries = Object.entries(this.config.providers);
			for (const [name, entry] of entries) {
				if (!this.taskIsCurrent(controller)) return;
				this.taskLabel = `发现 ${name}（${successful}/${entries.length}）`;
				this.requestRender();
				this.ctx.ui.setStatus("ai-manager", `Discovering ${name}…`);
				try {
					const key = await providerApiKey(this.ctx, name, entry);
					if (!this.taskIsCurrent(controller)) return;
					const list = await fetchModelList(entry.baseUrl, key, { signal: controller.signal, allowInsecureHttp: entry.allowInsecureHttp });
					if (!this.taskIsCurrent(controller)) return;
					applyDiscovery(entry, list);
					this.draftCache = null;
					if (this.state.selectedGateway === name) this.loadModels();
					successful++;
				} catch (error) {
					if (!this.taskIsCurrent(controller)) return;
					this.reportError(error);
				}
			}
			if (!this.taskIsCurrent(controller)) return;
			this.loadModels();
			this.notice = `已刷新 ${successful}/${entries.length} 个网关；Enter 保存草稿。`;
			this.ctx.ui.notify(`Refreshed ${successful}/${entries.length} gateways. Enter saves the draft.`, "info");
		});
	}

	private async testAllGateways(): Promise<void> {
		await this.runTask(async controller => {
			const tasks = Object.entries(this.config.providers).flatMap(([gateway, entry]) =>
				entry.enabledModels.filter(id => Object.hasOwn(entry.models, id)).map(modelId => ({ gateway, modelId })));
			if (!tasks.length) return;
			this.state.testingInProgress = true;
			this.state.testProgress = { current: 0, total: tasks.length };
			this.taskLabel = "测试所有网关";
			const questions = this.testQuestions();
			const limiters = new Map<string, RateLimiter>();
			for (const gateway of new Set(tasks.map(task => task.gateway))) {
				const key = await providerApiKey(this.ctx, gateway, this.config.providers[gateway]);
				if (!this.taskIsCurrent(controller)) return;
				if (key) this.sessionSecrets.add(key);
				this.registerTemporary(gateway, this.config.providers[gateway]);
				limiters.set(gateway, new RateLimiter(this.config.settings.testRequestDelayMs ?? DEFAULT_TEST_REQUEST_DELAY_MS));
			}
			let next = 0;
			let completed = 0;
			const worker = async () => {
				while (next < tasks.length && this.taskIsCurrent(controller)) {
					const index = next++;
					const { gateway, modelId } = tasks[index];
					this.beginModelTest(gateway, modelId);
					const result = await testModelFn(this.ctx, gateway, modelId, pickQuestions(questions, index), limiters.get(gateway)!, controller.signal, this.secretValues());
					if (!this.taskIsCurrent(controller)) return;
					this.recordTestResult(gateway, modelId, result);
					this.state.testProgress = { current: ++completed, total: tasks.length };
					this.requestRender();
				}
			};
			const count = Math.max(1, Math.min(this.config.settings.testConcurrency ?? DEFAULT_TEST_CONCURRENCY, tasks.length));
			await Promise.all(Array.from({ length: count }, worker));
			if (!this.taskIsCurrent(controller)) return;
			this.loadModels();
			this.ctx.ui.notify(`Tested ${completed} models. Enter saves the measurements.`, "info");
		});
	}

	// ---- add / delete provider ----

	private openAddForm(editing = false): void {
		const name = editing ? this.state.selectedGateway : undefined;
		const entry = name ? this.config.providers[name] : undefined;
		if (editing && !entry) return;
		const fields: AddProviderForm["fields"] = [new TextInput(), new TextInput(), new TextInput(true)];
		if (entry && name) {
			fields[0].value = name;
			fields[1].value = entry.baseUrl;
			fields[2].value = entry.apiKeyEnv ? `env:${entry.apiKeyEnv}` : entry.apiKey ?? "";
		}
		this.form = {
			fields, fieldIndex: editing ? 1 : 0, editingName: name,
			apiIndex: entry ? API_CHOICES.indexOf(entry.defaultApi) : DEFAULT_API_INDEX,
			detectState: "idle", status: "Key: literal or env:VARIABLE; blank uses /login. Ctrl+U clears a field.", statusKind: "info",
		};
		this.formOffset = 0;
		this.state.mode = "form";
	}

	private formEntry(f: AddProviderForm): { name: string; entry: RelayProviderEntry } {
		const name = f.editingName ?? f.fields[0].value.trim();
		const nameError = validateName(name);
		if (nameError) throw new Error(nameError);
		if (!f.editingName && (this.config.providers[name] || this.ctx.modelRegistry.getProvider?.(name))) {
			throw new Error(`Provider ${name} already exists. Use E to edit a gateway managed here.`);
		}
		const old = f.editingName ? this.config.providers[name] : undefined;
		const baseUrl = canonicalBaseUrl(f.fields[1].value, old?.allowInsecureHttp);
		if (!baseUrl) throw new Error("Use a valid HTTPS URL without credentials, query or fragment. HTTP is allowed for loopback.");
		const rawKey = f.fields[2].value.trim();
		const apiKeyEnv = rawKey.startsWith("env:") ? rawKey.slice(4) : undefined;
		if (apiKeyEnv !== undefined && !isEnvName(apiKeyEnv)) throw new Error("Use env:VARIABLE_NAME for an environment credential.");
		const entry: RelayProviderEntry = old ? JSON.parse(JSON.stringify(old)) : {
			baseUrl, defaultApi: API_CHOICES[f.apiIndex], models: Object.create(null), enabledModels: [],
		};
		entry.baseUrl = baseUrl;
		entry.defaultApi = API_CHOICES[f.apiIndex];
		delete entry.apiKey;
		delete entry.apiKeyEnv;
		if (apiKeyEnv) entry.apiKeyEnv = apiKeyEnv;
		else if (rawKey) entry.apiKey = rawKey;
		if (old && (old.baseUrl !== baseUrl || old.apiKey !== entry.apiKey || old.apiKeyEnv !== entry.apiKeyEnv)) {
			for (const meta of Object.values(entry.models)) { delete meta.health; delete meta.metrics; }
		}
		return { name, entry };
	}

	private async detectApiForForm(): Promise<void> {
		const f = this.form;
		if (!f || f.detectState !== "idle") return;
		let validated: { name: string; entry: RelayProviderEntry };
		try { validated = this.formEntry(f); }
		catch (error) { f.status = safeError(error); f.statusKind = "error"; return; }
		await this.runTask(async controller => {
			this.busy = true;
			f.detectState = "detecting";
			f.status = "Discovering models… Esc cancels.";
			try {
				const key = await providerApiKey(this.ctx, validated.name, validated.entry);
				if (!this.taskIsCurrent(controller) || this.form !== f) return;
				const list = await fetchModelList(validated.entry.baseUrl, key, { signal: controller.signal, allowInsecureHttp: validated.entry.allowInsecureHttp });
				if (!this.taskIsCurrent(controller) || this.form !== f) return;
				f.discovered = list;
				const detected = detectDefaultApi(list);
				if (detected !== "ambiguous" && !f.editingName) f.apiIndex = API_CHOICES.indexOf(detected);
				f.status = detected === "ambiguous" ? `Found ${list.length} models. Choose the API manually.` : `Found ${list.length} models (${detected}).`;
				f.statusKind = detected === "ambiguous" ? "warning" : "info";
			} catch (error) {
				if (!this.taskIsCurrent(controller) || this.form !== f) return;
				f.discovered = [];
				f.status = `Discovery unavailable: ${safeError(error, [validated.entry.apiKey ?? ""])}. You can still apply the form.`;
				f.statusKind = "warning";
			} finally {
				if (this.taskIsCurrent(controller) && this.form === f) f.detectState = "done";
			}
		});
	}

	private async submitForm(): Promise<void> {
		const f = this.form;
		if (!f) return;
		let validated: { name: string; entry: RelayProviderEntry };
		try { validated = this.formEntry(f); }
		catch (error) { f.status = safeError(error); f.statusKind = "error"; return; }
		await this.runTask(async controller => {
			this.busy = true;
			const { name, entry } = validated;
			let discovered = f.discovered;
			if (discovered === undefined) {
				try {
					const key = await providerApiKey(this.ctx, name, entry);
					if (!this.taskIsCurrent(controller) || this.form !== f) return;
					discovered = await fetchModelList(entry.baseUrl, key, { signal: controller.signal, allowInsecureHttp: entry.allowInsecureHttp });
				} catch (error) {
					if (!this.taskIsCurrent(controller) || this.form !== f) return;
					discovered = [];
					this.ctx.ui.notify(`Discovery unavailable: ${safeError(error, [entry.apiKey ?? ""])}`, "warning");
				}
			}
			if (!this.taskIsCurrent(controller) || this.form !== f) return;
			applyDiscovery(entry, discovered);
			const before = this.config.providers[name] ? JSON.parse(JSON.stringify(this.config.providers[name])) as RelayProviderEntry : undefined;
			this.operationHistory.record({ gateway: name, description: `${before ? "Edit" : "Add"} provider ${name}`, undo: () => {
				if (before) this.config.providers[name] = JSON.parse(JSON.stringify(before));
				else delete this.config.providers[name];
				this.state.selectedGateway = Object.keys(this.config.providers)[0] ?? "";
			} });
			this.config.providers[name] = entry;
			if (before && (before.baseUrl !== entry.baseUrl || before.apiKey !== entry.apiKey || before.apiKeyEnv !== entry.apiKeyEnv)) {
				for (const id of Object.keys(before.models)) this.sessionResults.delete(this.testKey(name, id));
			}
			this.state.selectedGateway = name;
			this.state.activePane = "models";
			this.loadModels();
			this.form = null;
			this.state.mode = "browse";
			this.ctx.ui.notify(`Provider ${name} ${before ? "updated" : "added"} to draft. Select models, then Enter to save.`, "info");
		});
	}

	private deleteProvider(name: string): void {
		const entry = this.config.providers[name];
		if (!entry) return;
		const before = JSON.parse(JSON.stringify(entry)) as RelayProviderEntry;
		this.operationHistory.record({ gateway: name, description: `Delete provider ${name}`, undo: () => {
			this.config.providers[name] = JSON.parse(JSON.stringify(before));
			this.state.selectedGateway = name;
		} });
		delete this.config.providers[name];
		this.state.selectedGateway = Object.keys(this.config.providers)[0] ?? "";
		this.loadModels();
		this.ctx.ui.notify(`Provider ${name} removed from draft. Enter saves; u restores it.`, "info");
	}

	// ---- input handler ----

	private openMenu(kind: MenuState["kind"]): void {
		this.menu = { kind, input: new TextInput(), index: 0, offset: 0 };
		this.state.mode = "menu";
	}

	private movePanel(data: string): boolean {
		const offset = this.state.mode === "help" ? this.helpOffset : this.panelOffset;
		let next = offset;
		if (matchesKey(data, Key.up)) next--;
		else if (matchesKey(data, Key.down)) next++;
		else if (matchesKey(data, Key.pageUp)) next -= this.panelRows;
		else if (matchesKey(data, Key.pageDown)) next += this.panelRows;
		else if (matchesKey(data, Key.home)) next = 0;
		else if (matchesKey(data, Key.end)) next = this.panelLength;
		else return false;
		next = Math.max(0, Math.min(next, this.panelLength - this.panelRows));
		if (this.state.mode === "help") this.helpOffset = next;
		else this.panelOffset = next;
		return true;
	}

	private async handleMenuInput(data: string): Promise<boolean> {
		const menu = this.menu!;
		const items = this.menuItems();
		if (matchesKey(data, Key.escape)) { this.menu = null; this.state.mode = "browse"; return true; }
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const step = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -this.menuRows : this.menuRows;
			menu.index = Math.max(0, Math.min(items.length - 1, menu.index + step));
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = items[menu.index];
			if (!selected?.enabled) return true;
			this.menu = null;
			this.state.mode = "browse";
			if (menu.kind === "filters") {
				if (selected.id === "reset") {
					this.state.filterMode = "all";
					this.state.qualityFilter = "all";
					this.filterInput.clear();
				} else if (selected.id.startsWith("filter:")) this.state.filterMode = selected.id.slice(7) as FilterMode;
				else if (selected.id.startsWith("quality:")) this.state.qualityFilter = selected.id.slice(8) as QualityFilter;
				this.state.activePane = "models";
				this.applyFiltersAndSort();
				return true;
			}
			return this.executeCommand(selected.id as CommandId);
		}
		if (menu.input.handleInput(data) === "typed") { menu.index = 0; menu.offset = 0; }
		return true;
	}

	async handleInput(data: string): Promise<boolean> {
		if (this.isClosed) return false;
		if (isKeyRelease(data)) return true;
		const deletePrefix = matchesKey(data, "d");
		if (!deletePrefix && this.lastKey === "d") {
			this.lastKey = "";
			this.notice = "";
		}
		// A separate stop command works even while a panel, search or form has focus.
		if (matchesKey(data, Key.ctrl("c")) && this.activeAbortController) {
			this.stopTask();
			if (this.form) {
				this.form.detectState = "idle";
				this.form.status = "发现已停止，表单已保留；Enter 可重试。";
				this.form.statusKind = "info";
			}
			return true;
		}
		if (this.busy) {
			if (matchesKey(data, Key.escape)) {
				this.stopTask();
				this.form = null;
				this.state.mode = "browse";
			}
			return true;
		}
		if (["help", "details", "changes", "compare"].includes(this.state.mode)) {
			if (this.movePanel(data)) return true;
			if (this.state.mode === "details" && this.state.activePane === "models") {
				const command = commandForInput(data, "models");
				if (command && MODEL_SETTING_COMMANDS.some(id => command.id === id)) {
					const blocked = this.commandBlocked(command);
					if (blocked) this.ctx.ui.notify(blocked, "warning");
					else return this.executeCommand(command.id);
					return true;
				}
			}
			if (matchesKey(data, Key.escape) || (matchesKey(data, "i") && this.state.mode === "details") ||
				(matchesKey(data, "v") && this.state.mode === "changes") || (matchesKey(data, "?") && this.state.mode === "help")) this.state.mode = "browse";
			else if (matchesKey(data, ":")) this.openMenu("actions");
			return true;
		}
		if (this.pendingTest) {
			const pending = this.pendingTest;
			if (this.movePanel(data)) return true;
			if (matchesKey(data, Key.escape)) this.pendingTest = null;
			else if (matchesKey(data, Key.enter)) {
				this.pendingTest = null;
				if (pending.allGateways) await this.testAllGateways();
				else await this.testModels(pending.ids ?? [], pending.gateway);
			}
			return true;
		}
		if (this.menu) return this.handleMenuInput(data);
		if (this.state.mode === "form" && this.form) return this.handleFormInput(data);
		if (this.state.mode === "context" && this.contextForm) return this.handleContextInput(data);
		if (this.state.mode === "pattern" && this.pattern) return this.handlePatternInput(data);
		if (this.confirmDelete) return this.movePanel(data) || this.handleConfirmInput(data);

		if (this.state.isFiltering) {
			const action = this.filterInput.handleInput(data);
			if (action === "cancel") {
				this.filterInput.value = this.searchBefore;
				this.state.isFiltering = false;
				if (this.searchSelection) {
					this.state.selectedModelIndex = this.searchSelection.index;
					this.state.scrollOffset = this.searchSelection.scroll;
				}
				this.applyFiltersAndSort(this.searchSelection?.modelId);
			} else if (action === "submit") this.state.isFiltering = false;
			else if (action === "typed") this.applyFiltersAndSort();
			return true;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.state.activePane = matchesKey(data, Key.left) ? "gateways" : matchesKey(data, Key.right) ? "models"
				: this.state.activePane === "models" ? "gateways" : "models";
			return true;
		}
		if ([Key.up, Key.down, Key.pageUp, Key.pageDown, Key.home, Key.end].some(key => matchesKey(data, key))) {
			const count = this.state.activePane === "models" ? this.state.filteredRows.length : Object.keys(this.config.providers).length;
			const current = this.state.activePane === "models" ? this.state.selectedModelIndex : Object.keys(this.config.providers).indexOf(this.state.selectedGateway);
			const next = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? count - 1
				: current + (matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -this.visibleRows : this.visibleRows);
			if (this.state.activePane === "models") {
				this.state.selectedModelIndex = Math.max(0, Math.min(count - 1, next));
				this.clampScroll();
				this.rememberModelView();
			} else this.selectGateway(next - current);
			return true;
		}

		if (deletePrefix && this.state.activePane === "gateways" && this.state.selectedGateway) {
			if (this.activeAbortController) { this.notice = "任务进行中，请先停止"; return true; }
			if (this.lastKey === "d") {
				this.confirmDelete = this.state.selectedGateway;
				this.panelOffset = 0;
				this.lastKey = "";
				this.notice = "";
			} else {
				this.lastKey = "d";
				this.notice = "再按 d 发起删除确认；其他键取消。";
			}
			return true;
		}
		const command = commandForInput(data, this.state.activePane);
		if (!command) return true;
		const blocked = this.commandBlocked(command);
		if (blocked) { this.notice = blocked; return true; }
		return this.executeCommand(command.id);
	}

	private async executeCommand(id: CommandId): Promise<boolean> {
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		const entry = this.config.providers[this.state.selectedGateway];
		switch (id) {
			case "toggle": {
				if (!row || !entry) break;
				const before = [...entry.enabledModels];
				row.enabled = !row.enabled;
				entry.enabledModels = row.enabled ? [...new Set([...entry.enabledModels, row.id])] : entry.enabledModels.filter(modelId => modelId !== row.id);
				this.recordOperation("toggle-model", this.state.selectedGateway, (row.enabled ? "Enabled " : "Disabled ") + row.id, before, entry.enabledModels);
				this.draftCache = null;
				this.applyFiltersAndSort();
				break;
			}
			case "test":
				if (row) await this.testModels([row.id]);
				break;
			case "test-visible": {
				const ids = this.state.filteredRows.map(row => row.id);
				if (ids.length) this.pendingTest = { gateway: this.state.selectedGateway, ids, allGateways: false, count: ids.length };
				else this.notice = "没有匹配的模型可测试";
				this.panelOffset = 0;
				break;
			}
			case "test-all": {
				const count = Object.values(this.config.providers).reduce((sum, entry) => sum + entry.enabledModels.filter(id => Object.hasOwn(entry.models, id)).length, 0);
				if (count) this.pendingTest = { allGateways: true, count };
				else this.notice = "没有已启用模型可测试";
				this.panelOffset = 0;
				break;
			}
			case "search":
				this.searchBefore = this.filterInput.value;
				this.searchSelection = { modelId: row?.id, index: this.state.selectedModelIndex, scroll: this.state.scrollOffset };
				this.state.isFiltering = true;
				this.state.activePane = "models";
				break;
			case "sort": {
				const modes: SortMode[] = ["name", "status", "performance", "enabled"];
				this.state.sortMode = modes[(modes.indexOf(this.state.sortMode) + 1) % modes.length];
				this.applyFiltersAndSort();
				break;
			}
			case "quality": {
				const modes: QualityFilter[] = ["all", "recommended", "strict"];
				this.state.qualityFilter = modes[(modes.indexOf(this.state.qualityFilter) + 1) % modes.length];
				this.applyFiltersAndSort();
				break;
			}
			case "refresh": await this.refreshModels(); break;
			case "refresh-all": await this.refreshAllGateways(); break;
			case "auto": await this.autoSelectModels(); break;
			case "dedup": await this.dedupModels(); break;
			case "undo": this.undoLastOperation(); break;
			case "context": this.openContextWindowForm(); break;
			case "compare": this.compareModel(); break;
			case "protocol": this.cycleModelApi(); break;
			case "reasoning": this.toggleModelReasoning(); break;
			case "enable-pattern":
			case "disable-pattern":
				this.pattern = { kind: id === "enable-pattern" ? "enable" : "disable", input: new TextInput() };
				this.state.mode = "pattern";
				break;
			case "add": this.openAddForm(); break;
			case "edit": this.openAddForm(true); break;
			case "delete":
				this.confirmDelete = this.state.selectedGateway;
				this.panelOffset = 0;
				break;
			case "actions": this.openMenu("actions"); break;
			case "filters": this.openMenu("filters"); break;
			case "help":
			case "details":
			case "changes":
				this.state.mode = id;
				this.helpOffset = 0;
				this.panelOffset = 0;
				break;
			case "stop": this.stopTask(); break;
			case "save":
				this.abortActiveTasks();
				if (!this.save()) return true;
				this.isClosed = true;
				this.saved = true;
				return false;
			case "discard":
				if (this.activeAbortController) { this.stopTask(); return true; }
				this.cancel();
				this.isClosed = true;
				this.saved = false;
				return false;
		}
		return true;
	}

	private async handleFormInput(data: string): Promise<boolean> {
		const f = this.form;
		if (!f) return true;

		if (matchesKey(data, Key.escape)) {
			this.form = null;
			this.state.mode = "browse";
			return true;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			f.fieldIndex = f.fieldIndex <= (f.editingName ? 1 : 0) ? 3 : f.fieldIndex - 1;
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
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
				f.fieldIndex = f.editingName ? 1 : 0;
				return true;
			}
			if (matchesKey(data, Key.enter)) {
				await this.submitForm();
				return true;
			}
			return true;
		}

		// Text fields: Enter/↓/Tab advances, ↑ goes back.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
			f.fieldIndex = Math.min(3, f.fieldIndex + 1);
			if (f.fieldIndex === 3) await this.detectApiForForm();
			return true;
		}
		if (matchesKey(data, Key.up)) {
			f.fieldIndex = Math.max(f.editingName ? 1 : 0, f.fieldIndex - 1);
			return true;
		}
		if (f.editingName && f.fieldIndex === 0) return true;
		const field = f.fields[f.fieldIndex];
		const previous = field.value;
		field.handleInput(data);
		if (field.value !== previous) {
			f.discovered = undefined;
			f.detectState = "idle";
		}
		return true;
	}

	private openContextWindowForm(): void {
		const row = this.state.filteredRows[this.state.selectedModelIndex];
		if (!row) return;
		this.contextForm = {
			modelId: row.id,
			input: new TextInput(),
			status: "",
			returnMode: this.state.mode === "details" ? "details" : "browse",
		};
		this.state.mode = "context";
	}

	private handleContextInput(data: string): boolean {
		const f = this.contextForm;
		if (!f) return true;
		const action = f.input.handleInput(data);
		if (action === "cancel") {
			this.contextForm = null;
			this.state.mode = f.returnMode;
			return true;
		}
		if (action !== "submit") return true;

		const entry = this.config.providers[this.state.selectedGateway];
		const meta = entry?.models[f.modelId];
		if (!entry || !meta) {
			this.contextForm = null;
			this.state.mode = "browse";
			return true;
		}
		const raw = f.input.value.trim();
		const previous = meta.contextWindow;
		if (!raw) {
			meta.contextWindow = undefined;
		} else {
			const parsed = parseContextWindow(raw);
			if (!parsed) {
				f.status = "Invalid value. Use a positive number, e.g. 128k, 256000, or 1m.";
				return true;
			}
			meta.contextWindow = parsed;
		}
		const next = meta.contextWindow;
		meta.contextWindow = previous;
		this.recordModelEdit(this.state.selectedGateway, f.modelId, `Set context window for ${f.modelId}`, ["contextWindow"]);
		meta.contextWindow = next;
		this.loadModels();
		this.contextForm = null;
		this.state.mode = f.returnMode;
		this.ctx.ui.notify(
			meta.contextWindow ? `Context window for "${f.modelId}" set to ${meta.contextWindow} tokens` : `Context window override cleared for "${f.modelId}"`,
			"info",
		);
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
		if (matchesKey(data, Key.shift("d")) || matchesKey(data, "d") || matchesKey(data, Key.enter)) {
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

		if (op.undoAction) {
			op.undoAction();
			this.loadModels();
			this.ctx.ui.notify(`Undone: ${op.description}`, "info");
			return;
		}

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
		try {
			return await this.ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
				this.requestRender = () => { if (!this.isClosed) tui.requestRender(); };
				return {
					render: (width: number) => this.render(width, tui.terminal?.rows ?? terminalHeight(), theme),
					invalidate: () => {},
					handleInput: (data: string) => {
						if (this.isClosed) return;
						void this.handleInput(data).then(shouldContinue => {
							if (!shouldContinue) done(this.saved);
							else this.requestRender();
						}).catch(error => {
							this.reportError(error);
							this.requestRender();
						});
					},
				};
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } }) ?? false;
		} finally {
			this.isClosed = true;
			this.abortActiveTasks();
			this.ctx.ui.setStatus("ai-manager", undefined);
			this.requestRender = () => {};
		}
	}
}
