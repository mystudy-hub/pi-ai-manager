// ---------------------------------------------------------------------------
// TUI State Management — Centralized state and operations history
// ---------------------------------------------------------------------------

import type { RelayConfig, RelayProviderEntry, RelayModelMeta, FilterMode, QualityFilter, SortMode, TestResult } from "./types.ts";
import { scoreModel, type ModelQualityScore } from "./model-scoring.ts";

// ---------------------------------------------------------------------------
// Core State Types
// ---------------------------------------------------------------------------

export interface ModelRow {
	id: string;
	enabled: boolean;
	testing: boolean;
	testResult?: TestResult;
	meta: RelayModelMeta;
	qualityScore?: ModelQualityScore;
}

export type TuiMode = "browse" | "form" | "pattern" | "help";
export type ActivePane = "gateways" | "models";

export interface TUIState {
	mode: TuiMode;
	activePane: ActivePane;
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

// ---------------------------------------------------------------------------
// Operation History for Undo/Redo
// ---------------------------------------------------------------------------

export type OperationType =
	| "toggle-model"
	| "enable-pattern"
	| "disable-pattern"
	| "auto-select"
	| "dedup"
	| "invert"
	| "toggle-all"
	| "delete-provider"
	| "add-provider";

export interface Operation {
	type: OperationType;
	timestamp: number;
	gateway: string;
	description: string;
	/** Snapshot of enabledModels before the operation */
	previousState: string[];
	/** Snapshot of enabledModels after the operation */
	newState: string[];
}

export class OperationHistory {
	private history: Operation[] = [];
	private maxSize = 50;
	private position = -1;

	push(op: Operation): void {
		// Remove any redo operations when pushing new operation
		this.history = this.history.slice(0, this.position + 1);
		this.history.push(op);

		// Keep history within size limit
		if (this.history.length > this.maxSize) {
			this.history.shift();
		} else {
			this.position++;
		}
	}

	canUndo(): boolean {
		return this.position >= 0;
	}

	canRedo(): boolean {
		return this.position < this.history.length - 1;
	}

	undo(): Operation | undefined {
		if (!this.canUndo()) return undefined;
		const op = this.history[this.position];
		this.position--;
		return op;
	}

	redo(): Operation | undefined {
		if (!this.canRedo()) return undefined;
		this.position++;
		return this.history[this.position];
	}

	peek(): Operation | undefined {
		return this.canUndo() ? this.history[this.position] : undefined;
	}

	clear(): void {
		this.history = [];
		this.position = -1;
	}

	getHistory(): readonly Operation[] {
		return this.history.slice(0, this.position + 1);
	}
}

// ---------------------------------------------------------------------------
// State Manager
// ---------------------------------------------------------------------------

export class TUIStateManager {
	private state: TUIState;
	private config: RelayConfig;
	private operationHistory = new OperationHistory();

	constructor(config: RelayConfig, initialGateway?: string) {
		this.config = config;
		const gateways = Object.keys(config.providers);
		const selectedGateway =
			initialGateway && gateways.includes(initialGateway)
				? initialGateway
				: gateways[0] ?? "";

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
	}

	getState(): Readonly<TUIState> {
		return this.state;
	}

	getConfig(): RelayConfig {
		return this.config;
	}

	getHistory(): OperationHistory {
		return this.operationHistory;
	}

	updateState(updates: Partial<TUIState>): void {
		this.state = { ...this.state, ...updates };
	}

	loadModels(selectedGateway?: string): void {
		const gateway = selectedGateway ?? this.state.selectedGateway;
		const entry = this.config.providers[gateway];

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
	}

	applyFiltersAndSort(filterText: string): void {
		let filtered = [...this.state.modelRows];

		// Quality filter
		if (this.state.qualityFilter !== "all") {
			const modelIds = filtered.map(r => r.id);
			const filteredIds = new Set(
				this.state.qualityFilter === "strict"
					? modelIds.filter(id => {
						const score = scoreModel(id);
						return score.isKnownGood && !score.isGarbage;
					})
					: modelIds.filter(id => {
						const score = scoreModel(id);
						return !score.isGarbage && score.recommendScore >= 40;
					})
			);
			filtered = filtered.filter(r => filteredIds.has(r.id));
		}

		// Text filter
		const search = filterText.toLowerCase();
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

	/**
	 * Record an operation for undo/redo.
	 * Returns the operation object.
	 */
	recordOperation(
		type: OperationType,
		gateway: string,
		description: string,
		previousState: string[],
		newState: string[]
	): Operation {
		const op: Operation = {
			type,
			timestamp: Date.now(),
			gateway,
			description,
			previousState: [...previousState],
			newState: [...newState],
		};
		this.operationHistory.push(op);
		return op;
	}

	/**
	 * Apply an operation state to the config.
	 * Used by both undo and redo.
	 */
	applyOperationState(gateway: string, enabledModels: string[]): void {
		const entry = this.config.providers[gateway];
		if (entry) {
			entry.enabledModels = [...enabledModels];
		}
	}
}
