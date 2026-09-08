/** Bounded undo history shared by all draft operations. */

export type OperationType =
	| "toggle-model"
	| "enable-pattern"
	| "disable-pattern"
	| "auto-select"
	| "dedup"
	| "invert"
	| "toggle-all"
	| "delete-provider"
	| "add-provider"
	| "toggle-reasoning"
	| "custom";

export interface Operation {
	type: OperationType;
	timestamp: number;
	gateway: string;
	description: string;
	/** Snapshot of enabledModels before the operation */
	previousState: string[];
	/** Snapshot of enabledModels after the operation */
	newState: string[];
	undoAction?: () => void;
}

export class OperationHistory {
	private history: Operation[] = [];
	private maxSize = 50;
	private position = -1;

	constructor(maxSize = 50) {
		this.maxSize = maxSize;
	}

	record(op: { description: string; undo?: () => void; gateway?: string }): void {
		this.push({
			type: "custom",
			timestamp: Date.now(),
			gateway: op.gateway ?? "",
			description: op.description,
			previousState: [],
			newState: [],
			undoAction: op.undo,
		});
	}

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
