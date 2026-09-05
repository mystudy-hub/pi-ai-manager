// ---------------------------------------------------------------------------
// Unified Error Handling and Recovery
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
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
			message,
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
				console.error(prefix, message, metadata);
				break;
			case "recoverable":
				console.warn(prefix, message, metadata);
				break;
			case "warning":
				console.log(prefix, message, metadata);
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
			writeFileSync(
				this.logPath,
				this.errorLog.map(e => JSON.stringify(e)).join("\n"),
				"utf-8"
			);
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
		mkdirSync(backupDir, { recursive: true });
	}

	/**
	 * Create a backup before writing config
	 */
	backup(configPath: string): ConfigBackup | undefined {
		if (!existsSync(configPath)) return undefined;

		try {
			const content = readFileSync(configPath, "utf-8");
			const timestamp = Date.now();
			const backupPath = join(
				this.backupDir,
				`provider-ai.backup.${timestamp}.json`
			);

			writeFileSync(backupPath, content, "utf-8");

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

				const match = file.match(/provider-ai\.backup\.(\d+)\.json/);
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
			writeFileSync(targetPath, backup.content, "utf-8");
			return true;
		} catch (error) {
			console.error("Failed to restore backup:", error);
			return false;
		}
	}

	/**
	 * Try to recover config from backups
	 */
	tryRecover(targetPath: string): ConfigBackup | undefined {
		const backups = this.listBackups();
		for (const backup of backups) {
			try {
				// Validate JSON
				JSON.parse(backup.content);
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
				`Failed to parse config: ${error instanceof Error ? error.message : String(error)}`,
				{ configPath }
			);

			// Try to recover from backup
			const backup = recovery.tryRecover(configPath);
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

		// Write atomically (implemented in config.ts)
		const dir = dirname(configPath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;

		writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, configPath);

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
