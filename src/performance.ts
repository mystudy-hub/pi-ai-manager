// ---------------------------------------------------------------------------
// Performance Optimization Utilities
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
	value: V;
	expiry: number;
}

export class TTLCache<K = string, V = any> {
	private cache = new Map<K, CacheEntry<V>>();
	private defaultTTL: number;

	constructor(defaultTTL = 300_000) {
		this.defaultTTL = defaultTTL;
	}

	set(key: K, value: V, ttl?: number): void {
		const expiry = Date.now() + (ttl ?? this.defaultTTL);
		this.cache.set(key, { value, expiry });
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;

		if (Date.now() > entry.expiry) {
			this.cache.delete(key);
			return undefined;
		}

		return entry.value;
	}

	has(key: K): boolean {
		return this.get(key) !== undefined;
	}

	delete(key: K): void {
		this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
	}

	cleanup(): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [key, entry] of this.cache.entries()) {
			if (now > entry.expiry) {
				this.cache.delete(key);
				cleaned++;
			}
		}

		return cleaned;
	}

	size(): number {
		this.cleanup();
		return this.cache.size;
	}
}

// ---------------------------------------------------------------------------
// Config Writer with Debouncing
// ---------------------------------------------------------------------------

export class ConfigWriter {
	private pendingWrite: any = null;
	private pendingFn: (() => void) | null = null;
	private defaultDelayMs: number;
	private defaultWriteFn?: (data: any) => void;

	constructor(delayMs = 500, writeFn?: (data: any) => void) {
		this.defaultDelayMs = delayMs;
		this.defaultWriteFn = writeFn;
	}

	write(data: any): void {
		if (this.defaultWriteFn) {
			this.scheduleWrite(() => this.defaultWriteFn!(data), this.defaultDelayMs);
		}
	}

	scheduleWrite(fn: () => void, delayMs = this.defaultDelayMs): void {
		// Cancel existing pending write
		if (this.pendingWrite) {
			clearTimeout(this.pendingWrite);
		}

		this.pendingFn = fn;
		this.pendingWrite = setTimeout(() => {
			if (this.pendingFn) {
				this.pendingFn();
				this.pendingFn = null;
			}
			this.pendingWrite = null;
		}, delayMs);
	}

	flush(): void {
		if (this.pendingWrite) {
			clearTimeout(this.pendingWrite);
			this.pendingWrite = null;
		}

		if (this.pendingFn) {
			this.pendingFn();
			this.pendingFn = null;
		}
	}

	cancel(): void {
		if (this.pendingWrite) {
			clearTimeout(this.pendingWrite);
			this.pendingWrite = null;
		}
		this.pendingFn = null;
	}
}

// ---------------------------------------------------------------------------
// Virtual Scroller
// ---------------------------------------------------------------------------

export class VirtualScroller<T> {
	private items: T[] = [];
	private viewportSize = 10;
	private scrollOffset = 0;

	setItems(items: T[]): void {
		this.items = items;
		this.clampScrollOffset();
	}

	setViewportSize(size: number): void {
		this.viewportSize = Math.max(1, size);
		this.clampScrollOffset();
	}

	setScrollOffset(offset: number): void {
		this.scrollOffset = offset;
		this.clampScrollOffset();
	}

	getVisibleItems(): T[] {
		if (this.items.length <= this.viewportSize) {
			return this.items;
		}

		return this.items.slice(
			this.scrollOffset,
			this.scrollOffset + this.viewportSize
		);
	}

	getScrollInfo(): { offset: number; total: number; visible: number } {
		return {
			offset: this.scrollOffset,
			total: this.items.length,
			visible: Math.min(this.viewportSize, this.items.length),
		};
	}

	/**
	 * Adjust scroll offset to keep a selection index visible
	 */
	clampSelection(selectedIndex: number): number {
		const clamped = Math.max(0, Math.min(selectedIndex, this.items.length - 1));

		// Scroll down if selection is below viewport
		if (clamped >= this.scrollOffset + this.viewportSize) {
			this.scrollOffset = clamped - this.viewportSize + 1;
		}

		// Scroll up if selection is above viewport
		if (clamped < this.scrollOffset) {
			this.scrollOffset = clamped;
		}

		this.clampScrollOffset();
		return clamped;
	}

	private clampScrollOffset(): void {
		const maxScroll = Math.max(0, this.items.length - this.viewportSize);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
	}
}

// ---------------------------------------------------------------------------
// Render Cache
// ---------------------------------------------------------------------------

interface RenderCacheEntry {
	width: number;
	height: number;
	stateHash: string;
	lines: string[];
	timestamp: number;
}

export class RenderCache {
	private cache: RenderCacheEntry | null = null;
	private ttl = 100; // 100ms cache

	get(width: number, height: number, stateHash: string): string[] | undefined {
		if (!this.cache) return undefined;

		if (
			this.cache.width === width &&
			this.cache.height === height &&
			this.cache.stateHash === stateHash &&
			Date.now() - this.cache.timestamp < this.ttl
		) {
			return this.cache.lines;
		}

		return undefined;
	}

	set(width: number, height: number, stateHash: string, lines: string[]): void {
		this.cache = {
			width,
			height,
			stateHash,
			lines,
			timestamp: Date.now(),
		};
	}

	invalidate(): void {
		this.cache = null;
	}
}

// ---------------------------------------------------------------------------
// State Hashing
// ---------------------------------------------------------------------------

export function hashState(obj: unknown): string {
	// Simple JSON-based hashing for cache invalidation
	return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Operation Queue with Concurrency Control
// ---------------------------------------------------------------------------

interface QueuedOperation<T> {
	id: string;
	operation: () => Promise<T>;
	priority: number;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

export class OperationQueue {
	private queue: QueuedOperation<unknown>[] = [];
	private running = 0;
	private maxConcurrency = 3;

	enqueue<T>(id: string, operation: () => Promise<T>, priority = 0): Promise<T> {
		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				operation: operation as () => Promise<unknown>,
				priority,
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			this.queue.sort((a, b) => b.priority - a.priority);
			this.processQueue();
		});
	}

	setConcurrency(n: number): void {
		this.maxConcurrency = Math.max(1, n);
		this.processQueue();
	}

	private async processQueue(): Promise<void> {
		while (this.running < this.maxConcurrency && this.queue.length > 0) {
			const op = this.queue.shift();
			if (!op) break;

			this.running++;

			try {
				const result = await op.operation();
				op.resolve(result);
			} catch (error) {
				op.reject(error);
			} finally {
				this.running--;
				this.processQueue();
			}
		}
	}
}
