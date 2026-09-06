// TUI Event Handlers - Event handling logic for AI Gateway TUI
// Separated from tui.ts for better maintainability

import type { DiscoveredModel, RelayConfig, ProviderEntry } from "./types.ts";
import type { TUIState, OperationHistory } from "./tui-state.ts";

export interface HandlerContext {
	config: RelayConfig;
	state: TUIState;
	selectedGateway: string;
	models: DiscoveredModel[];
	filteredModels: DiscoveredModel[];
	operationHistory: OperationHistory;
}

export interface HandlerResult {
	shouldRedraw: boolean;
	shouldExit?: boolean;
	shouldSave?: boolean;
	message?: string;
	messageType?: "info" | "success" | "warning" | "error";
}

/**
 * Handle navigation keys (up, down, left, right)
 */
export function handleNavigation(
	key: string,
	ctx: HandlerContext
): HandlerResult {
	switch (key) {
		case "up":
		case "k":
			if (ctx.state.selectedIndex > 0) {
				ctx.state.selectedIndex--;
				return { shouldRedraw: true };
			}
			break;

		case "down":
		case "j":
			if (ctx.state.selectedIndex < ctx.filteredModels.length - 1) {
				ctx.state.selectedIndex++;
				return { shouldRedraw: true };
			}
			break;

		case "left":
		case "h":
			// Switch to previous gateway
			return { shouldRedraw: true, message: "Switch gateway left" };

		case "right":
		case "l":
			// Switch to next gateway
			return { shouldRedraw: true, message: "Switch gateway right" };

		case "pageup":
			ctx.state.selectedIndex = Math.max(0, ctx.state.selectedIndex - 10);
			return { shouldRedraw: true };

		case "pagedown":
			ctx.state.selectedIndex = Math.min(
				ctx.filteredModels.length - 1,
				ctx.state.selectedIndex + 10
			);
			return { shouldRedraw: true };

		case "home":
			ctx.state.selectedIndex = 0;
			return { shouldRedraw: true };

		case "end":
			ctx.state.selectedIndex = ctx.filteredModels.length - 1;
			return { shouldRedraw: true };
	}

	return { shouldRedraw: false };
}

/**
 * Handle model toggle (space key)
 */
export function handleModelToggle(ctx: HandlerContext): HandlerResult {
	if (ctx.filteredModels.length === 0) {
		return { shouldRedraw: false };
	}

	const selectedModel = ctx.filteredModels[ctx.state.selectedIndex];
	const entry = ctx.config.providers[ctx.selectedGateway];

	if (!entry) {
		return { shouldRedraw: false };
	}

	// Find the model in the full list
	const modelIndex = ctx.models.findIndex(m => m.id === selectedModel.id);
	if (modelIndex === -1) {
		return { shouldRedraw: false };
	}

	// Record operation for undo
	const previousState = [...entry.enabledModels];

	// Toggle the model
	const isCurrentlyEnabled = entry.enabledModels.includes(selectedModel.id);
	if (isCurrentlyEnabled) {
		entry.enabledModels = entry.enabledModels.filter(id => id !== selectedModel.id);
	} else {
		entry.enabledModels.push(selectedModel.id);
	}

	// Update the model's enabled state
	ctx.models[modelIndex].enabled = !isCurrentlyEnabled;
	selectedModel.enabled = !isCurrentlyEnabled;

	// Record operation
	ctx.operationHistory.push({
		type: "toggle-model",
		timestamp: Date.now(),
		gateway: ctx.selectedGateway,
		description: `Toggle ${selectedModel.id}`,
		previousState,
		newState: [...entry.enabledModels],
	});

	return {
		shouldRedraw: true,
		message: `${selectedModel.id} ${selectedModel.enabled ? "enabled" : "disabled"}`,
		messageType: "success",
	};
}

/**
 * Handle filter mode input
 */
export function handleFilterInput(
	input: string,
	currentPattern: string
): { pattern: string; shouldApply: boolean; shouldCancel: boolean } {
	if (input === "enter") {
		return { pattern: currentPattern, shouldApply: true, shouldCancel: false };
	}

	if (input === "escape") {
		return { pattern: "", shouldApply: false, shouldCancel: true };
	}

	if (input === "backspace") {
		return {
			pattern: currentPattern.slice(0, -1),
			shouldApply: false,
			shouldCancel: false,
		};
	}

	// Add character to pattern
	if (input.length === 1 && input >= " " && input <= "~") {
		return {
			pattern: currentPattern + input,
			shouldApply: false,
			shouldCancel: false,
		};
	}

	return { pattern: currentPattern, shouldApply: false, shouldCancel: false };
}

/**
 * Handle pattern enable/disable mode
 */
export function handlePatternMode(
	input: string,
	currentPattern: string,
	mode: "enable" | "disable"
): {
	pattern: string;
	shouldApply: boolean;
	shouldCancel: boolean;
	affectedCount?: number;
} {
	const filterResult = handleFilterInput(input, currentPattern);

	if (filterResult.shouldApply && filterResult.pattern) {
		// Count how many models would be affected
		// This would need access to the models list, so return and let caller handle it
		return { ...filterResult, affectedCount: undefined };
	}

	return filterResult;
}

/**
 * Apply pattern enable/disable
 */
export function applyPattern(
	pattern: string,
	mode: "enable" | "disable",
	ctx: HandlerContext
): HandlerResult {
	const entry = ctx.config.providers[ctx.selectedGateway];
	if (!entry) {
		return {
			shouldRedraw: false,
			message: "No gateway selected",
			messageType: "error",
		};
	}

	const previousState = [...entry.enabledModels];

	// Convert pattern to regex
	const regex = new RegExp(
		pattern.replace(/\*/g, ".*").replace(/\?/g, "."),
		"i"
	);

	// Find matching models
	const matchingModels = ctx.models.filter(m => regex.test(m.id));

	if (matchingModels.length === 0) {
		return {
			shouldRedraw: false,
			message: `No models match pattern: ${pattern}`,
			messageType: "warning",
		};
	}

	// Apply enable/disable
	for (const model of matchingModels) {
		if (mode === "enable") {
			if (!entry.enabledModels.includes(model.id)) {
				entry.enabledModels.push(model.id);
			}
			model.enabled = true;
		} else {
			entry.enabledModels = entry.enabledModels.filter(id => id !== model.id);
			model.enabled = false;
		}
	}

	// Record operation
	ctx.operationHistory.push({
		type: mode === "enable" ? "enable-pattern" : "disable-pattern",
		timestamp: Date.now(),
		gateway: ctx.selectedGateway,
		description: `${mode === "enable" ? "Enabled" : "Disabled"} ${matchingModels.length} models matching ${pattern}`,
		previousState,
		newState: [...entry.enabledModels],
	});

	return {
		shouldRedraw: true,
		message: `${mode === "enable" ? "Enabled" : "Disabled"} ${matchingModels.length} models`,
		messageType: "success",
	};
}

/**
 * Handle auto-select recommended models
 */
export function handleAutoSelect(ctx: HandlerContext): HandlerResult {
	const entry = ctx.config.providers[ctx.selectedGateway];
	if (!entry) {
		return {
			shouldRedraw: false,
			message: "No gateway selected",
			messageType: "error",
		};
	}

	const previousState = [...entry.enabledModels];

	// Select models with quality "good" or "ok"
	const goodModels = ctx.models.filter(
		m => m.quality === "good" || m.quality === "ok"
	);

	if (goodModels.length === 0) {
		return {
			shouldRedraw: false,
			message: "No good/ok quality models found",
			messageType: "warning",
		};
	}

	// Enable all good models
	entry.enabledModels = goodModels.map(m => m.id);

	// Update model states
	for (const model of ctx.models) {
		model.enabled = entry.enabledModels.includes(model.id);
	}

	// Record operation
	ctx.operationHistory.push({
		type: "auto-select",
		timestamp: Date.now(),
		gateway: ctx.selectedGateway,
		description: `Auto-selected ${goodModels.length} models`,
		previousState,
		newState: [...entry.enabledModels],
	});

	return {
		shouldRedraw: true,
		message: `Auto-selected ${goodModels.length} recommended models`,
		messageType: "success",
	};
}

/**
 * Handle dedup operation
 */
export function handleDedup(ctx: HandlerContext): HandlerResult {
	const entry = ctx.config.providers[ctx.selectedGateway];
	if (!entry) {
		return {
			shouldRedraw: false,
			message: "No gateway selected",
			messageType: "error",
		};
	}

	const previousState = [...entry.enabledModels];

	// Group models by base name (remove version/date suffixes)
	const groups = new Map<string, DiscoveredModel[]>();

	for (const model of ctx.models) {
		// Extract base name (remove dates, versions, etc.)
		const baseName = model.id
			.replace(/-\d{8}$/, "")
			.replace(/-v\d+$/, "")
			.replace(/-\d{4}$/, "");

		if (!groups.has(baseName)) {
			groups.set(baseName, []);
		}
		groups.get(baseName)!.push(model);
	}

	// For each group, keep only the fastest one
	const toDisable: string[] = [];

	for (const [baseName, models] of groups) {
		if (models.length <= 1) continue;

		// Sort by latency (fastest first)
		models.sort((a, b) => {
			if (!a.latencyMs) return 1;
			if (!b.latencyMs) return -1;
			return a.latencyMs - b.latencyMs;
		});

		// Keep the first (fastest), disable the rest
		for (let i = 1; i < models.length; i++) {
			toDisable.push(models[i].id);
		}
	}

	if (toDisable.length === 0) {
		return {
			shouldRedraw: false,
			message: "No duplicates found",
			messageType: "info",
		};
	}

	// Disable slower duplicates
	entry.enabledModels = entry.enabledModels.filter(
		id => !toDisable.includes(id)
	);

	// Update model states
	for (const model of ctx.models) {
		if (toDisable.includes(model.id)) {
			model.enabled = false;
		}
	}

	// Record operation
	ctx.operationHistory.push({
		type: "dedup",
		timestamp: Date.now(),
		gateway: ctx.selectedGateway,
		description: `Disabled ${toDisable.length} slower duplicates`,
		previousState,
		newState: [...entry.enabledModels],
	});

	return {
		shouldRedraw: true,
		message: `Disabled ${toDisable.length} slower duplicates`,
		messageType: "success",
	};
}

/**
 * Handle undo operation
 */
export function handleUndo(ctx: HandlerContext): HandlerResult {
	const operation = ctx.operationHistory.undo();

	if (!operation) {
		return {
			shouldRedraw: false,
			message: "Nothing to undo",
			messageType: "warning",
		};
	}

	// Restore previous state
	const entry = ctx.config.providers[operation.gateway];
	if (!entry) {
		return {
			shouldRedraw: false,
			message: "Gateway not found",
			messageType: "error",
		};
	}

	entry.enabledModels = [...operation.previousState];

	// Update model states
	for (const model of ctx.models) {
		model.enabled = entry.enabledModels.includes(model.id);
	}

	return {
		shouldRedraw: true,
		message: `Undone: ${operation.description}`,
		messageType: "success",
	};
}

/**
 * Handle redo operation
 */
export function handleRedo(ctx: HandlerContext): HandlerResult {
	const operation = ctx.operationHistory.redo();

	if (!operation) {
		return {
			shouldRedraw: false,
			message: "Nothing to redo",
			messageType: "warning",
		};
	}

	// Restore new state
	const entry = ctx.config.providers[operation.gateway];
	if (!entry) {
		return {
			shouldRedraw: false,
			message: "Gateway not found",
			messageType: "error",
		};
	}

	entry.enabledModels = [...operation.newState];

	// Update model states
	for (const model of ctx.models) {
		model.enabled = entry.enabledModels.includes(model.id);
	}

	return {
		shouldRedraw: true,
		message: `Redone: ${operation.description}`,
		messageType: "success",
	};
}

/**
 * Handle sort mode toggle
 */
export function handleSortToggle(ctx: HandlerContext): HandlerResult {
	const modes = ["name", "status", "performance", "enabled"] as const;
	const currentIndex = modes.indexOf(ctx.state.sortMode as any);
	const nextIndex = (currentIndex + 1) % modes.length;

	ctx.state.sortMode = modes[nextIndex];

	return {
		shouldRedraw: true,
		message: `Sort by: ${ctx.state.sortMode}`,
		messageType: "info",
	};
}

/**
 * Handle quality filter toggle
 */
export function handleQualityFilterToggle(ctx: HandlerContext): HandlerResult {
	const modes = ["all", "recommended", "strict"] as const;
	const currentIndex = modes.indexOf(ctx.state.qualityFilter as any);
	const nextIndex = (currentIndex + 1) % modes.length;
	ctx.state.qualityFilter = modes[nextIndex];

	return {
		shouldRedraw: true,
		message: `Quality filter: ${ctx.state.qualityFilter}`,
		messageType: "info",
	};
}

/**
 * Sort models based on current sort mode
 */
export function sortModels(
	models: DiscoveredModel[],
	sortMode: string
): DiscoveredModel[] {
	const sorted = [...models];

	switch (sortMode) {
		case "name":
			sorted.sort((a, b) => a.id.localeCompare(b.id));
			break;

		case "quality":
			const qualityOrder = { good: 0, ok: 1, poor: 2, garbage: 3, unknown: 4 };
			sorted.sort((a, b) => {
				const aOrder = qualityOrder[a.quality as keyof typeof qualityOrder] ?? 4;
				const bOrder = qualityOrder[b.quality as keyof typeof qualityOrder] ?? 4;
				return aOrder - bOrder;
			});
			break;

		case "speed":
			sorted.sort((a, b) => {
				if (!a.latencyMs) return 1;
				if (!b.latencyMs) return -1;
				return a.latencyMs - b.latencyMs;
			});
			break;

		case "api-type":
			sorted.sort((a, b) => {
				const aType = a.apiType || "unknown";
				const bType = b.apiType || "unknown";
				return aType.localeCompare(bType);
			});
			break;
	}

	return sorted;
}

/**
 * Filter models based on pattern and quality
 */
export function filterModels(
	models: DiscoveredModel[],
	pattern: string,
	qualityFilter: boolean
): DiscoveredModel[] {
	let filtered = models;

	// Apply quality filter
	if (qualityFilter) {
		filtered = filtered.filter(
			m => m.quality === "good" || m.quality === "ok"
		);
	}

	// Apply pattern filter
	if (pattern) {
		const regex = new RegExp(pattern, "i");
		filtered = filtered.filter(m => regex.test(m.id));
	}

	return filtered;
}
