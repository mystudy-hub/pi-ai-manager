// ---------------------------------------------------------------------------
// Unified Error Handling and Recovery
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "./storage.ts";
import { safeError } from "./security.ts";
import { dirname, join } from "node:path";

export type ErrorLevel = "fatal" | "recoverable" | "warning";

export interface ErrorContext {
	level: ErrorLevel;
	code: string;
	message: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
	stack?: string;
}

export class ErrorHandler {
	private errorLog: ErrorContext[] = [];
	private maxLogSize = 100;
	private logPath?: string;

	constructor(logPath?: string) {
		this.logPath = logPath;
	}

	/**
	 * Record an error with context
	 */
	record(level: ErrorLevel, code: string, message: string, metadata?: Record<string, unknown>): ErrorContext {
		const ctx: ErrorContext = {
			level,
			code,
			message: safeError(message),
			timestamp: Date.now(),
			metadata,
			stack: new Error().stack,
		};

		this.errorLog.push(ctx);
		if (this.errorLog.length > this.maxLogSize) {
			this.errorLog.shift();
		}

		// Log to console based on level
		const prefix = `[ai-gateway:${level}:${code}]`;
		switch (level) {
			case "fatal":
				console.error(prefix, ctx.message);
				break;
			case "recoverable":
				console.warn(prefix, ctx.message);
				break;
			case "warning":
				console.log(prefix, ctx.message);
				break;
		}

		// Persist fatal errors immediately
		if (level === "fatal" && this.logPath) {
			this.flush();
		}

		return ctx;
	}

	/**
	 * Flush error log to disk
	 */
	flush(): void {
		if (!this.logPath) return;
		try {
			const dir = dirname(this.logPath);
			mkdirSync(dir, { recursive: true });
			atomicWrite(this.logPath, this.errorLog.map(e => JSON.stringify(e)).join("\n"));
		} catch (err) {
			console.error("Failed to write error log:", err);
		}
	}

	/**
	 * Get recent errors
	 */
	getRecent(count = 10): readonly ErrorContext[] {
		return this.errorLog.slice(-count);
	}

	/**
	 * Get errors by level
	 */
	getByLevel(level: ErrorLevel): readonly ErrorContext[] {
		return this.errorLog.filter(e => e.level === level);
	}

	/**
	 * Clear error log
	 */
	clear(): void {
		this.errorLog = [];
	}
}

// ---------------------------------------------------------------------------
// Config Backup and Recovery
// ---------------------------------------------------------------------------

export interface ConfigBackup {
	timestamp: number;
	content: string;
	path: string;
}

export class ConfigRecovery {
	private backupDir: string;
	private maxBackups = 10;

	constructor(backupDir: string) {
		this.backupDir = backupDir;
		mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	}

	/**
	 * Create a backup before writing config
	 */
	backup(configPath: string): ConfigBackup | undefined {
		if (!existsSync(configPath)) return undefined;

		try {
			const content = readFileSync(configPath, "utf-8");
			JSON.parse(content);
			const timestamp = Date.now();
			const backupPath = join(
				this.backupDir,
				`provider-ai.backup.${timestamp}-${randomUUID()}.json`
			);

			atomicWrite(backupPath, content);

			// Clean old backups
			this.cleanOldBackups();

			return {
				timestamp,
				content,
				path: backupPath,
			};
		} catch (error) {
			console.error("Failed to create config backup:", error);
			return undefined;
		}
	}

	/**
	 * List available backups, newest first
	 */
	listBackups(): ConfigBackup[] {
		try {
			const files = readdirSync(this.backupDir);
			const backups: ConfigBackup[] = [];

			for (const file of files) {
				if (!file.startsWith("provider-ai.backup.") || !file.endsWith(".json")) {
					continue;
				}

				const match = file.match(/^provider-ai\.backup\.(\d+)(?:-[\w-]+)?\.json$/);
				if (!match) continue;

				const timestamp = parseInt(match[1], 10);
				const path = join(this.backupDir, file);

				try {
					const content = readFileSync(path, "utf-8");
					backups.push({ timestamp, content, path });
				} catch {
					// Skip unreadable backups
				}
			}

			return backups.sort((a, b) => b.timestamp - a.timestamp);
		} catch {
			return [];
		}
	}

	/**
	 * Restore from a backup
	 */
	restore(backup: ConfigBackup, targetPath: string): boolean {
		try {
			atomicWrite(targetPath, backup.content);
			return true;
		} catch (error) {
			console.error("Failed to restore backup:", error);
			return false;
		}
	}

	/**
	 * Try to recover config from backups
	 */
	tryRecover(targetPath: string, validate: (content: string) => unknown = JSON.parse): ConfigBackup | undefined {
		const backups = this.listBackups();
		for (const backup of backups) {
			try {
				// Validate JSON
				validate(backup.content);
				if (this.restore(backup, targetPath)) {
					return backup;
				}
			} catch {
				// Try next backup
				continue;
			}
		}
		return undefined;
	}

	/**
	 * Keep only the most recent N backups
	 */
	private cleanOldBackups(): void {
		try {
			const backups = this.listBackups();
			if (backups.length <= this.maxBackups) return;

			const toDelete = backups.slice(this.maxBackups);
			for (const backup of toDelete) {
				try {
					unlinkSync(backup.path);
				} catch {
					// Ignore deletion failures
				}
			}
		} catch {
			// Ignore cleanup failures
		}
	}
}

// ---------------------------------------------------------------------------
// Safe Config Operations
// ---------------------------------------------------------------------------

export interface SafeConfigResult<T> {
	success: boolean;
	data?: T;
	error?: ErrorContext;
	recoveredFrom?: string;
}

/**
 * Safely read config with automatic recovery
 */
export function safeReadConfig<T>(
	configPath: string,
	recovery: ConfigRecovery,
	errorHandler: ErrorHandler,
	parser: (content: string) => T,
	fallback: () => T
): SafeConfigResult<T> {
	// Try to read the main config
	if (existsSync(configPath)) {
		try {
			const content = readFileSync(configPath, "utf-8");
			const data = parser(content);
			return { success: true, data };
		} catch (error) {
			const ctx = errorHandler.record(
				"recoverable",
				"CONFIG_PARSE_ERROR",
				"Config is unreadable or contains invalid JSON",
				{ configPath }
			);

			// Try to recover from backup
			const backup = recovery.tryRecover(configPath, parser);
			if (backup) {
				try {
					const data = parser(backup.content);
					errorHandler.record(
						"warning",
						"CONFIG_RECOVERED",
						`Config recovered from backup: ${new Date(backup.timestamp).toISOString()}`,
						{ backupPath: backup.path }
					);
					return {
						success: true,
						data,
						recoveredFrom: backup.path,
					};
				} catch {
					// Recovery failed, fall through to empty config
				}
			}

			return { success: false, error: ctx, data: fallback() };
		}
	}

	// Config doesn't exist, return empty
	return { success: true, data: fallback() };
}

/**
 * Safely write config with automatic backup
 */
export function safeWriteConfig(
	configPath: string,
	content: string,
	recovery: ConfigRecovery,
	errorHandler: ErrorHandler
): SafeConfigResult<void> {
	try {
		// Create backup before writing
		recovery.backup(configPath);

		// Validate JSON before writing
		JSON.parse(content);

		atomicWrite(configPath, content);

		return { success: true };
	} catch (error) {
		const ctx = errorHandler.record(
			"fatal",
			"CONFIG_WRITE_ERROR",
			`Failed to write config: ${error instanceof Error ? error.message : String(error)}`,
			{ configPath }
		);
		return { success: false, error: ctx };
	}
}
