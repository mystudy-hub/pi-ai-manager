// ---------------------------------------------------------------------------
// Enhanced Config Management with Recovery
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { settingsDirectory } from "./paths.ts";
import type { RelayConfig } from "./types.ts";
import { ConfigRecovery, ErrorHandler, safeReadConfig, safeWriteConfig } from "./error-handler.ts";

// ---------------------------------------------------------------------------
// Global Instances
// ---------------------------------------------------------------------------

let configRecoveryInstance: ConfigRecovery | undefined;
let errorHandlerInstance: ErrorHandler | undefined;

function getBackupDir(): string {
	// Use the same directory as config but in a backups subdirectory
	const settingsDir = settingsDirectory();
	return join(settingsDir, "backups");
}

function getErrorLogPath(): string {
	const settingsDir = settingsDirectory();
	return join(settingsDir, "ai-gateway-errors.log");
}

export function getConfigRecoveryInstance(): ConfigRecovery {
	if (!configRecoveryInstance) {
		configRecoveryInstance = new ConfigRecovery(getBackupDir());
	}
	return configRecoveryInstance;
}

export function getErrorHandlerInstance(): ErrorHandler {
	if (!errorHandlerInstance) {
		errorHandlerInstance = new ErrorHandler(getErrorLogPath());
	}
	return errorHandlerInstance;
}

// ---------------------------------------------------------------------------
// Safe Config Operations
// ---------------------------------------------------------------------------

/**
 * Safely read config with automatic recovery from backups
 */
export function readConfigSafe(): RelayConfig {
	const configPath = join(
		settingsDirectory(),
		"provider-ai.json"
	);

	const recovery = getConfigRecoveryInstance();
	const errorHandler = getErrorHandlerInstance();

	const emptyConfig = (): RelayConfig => ({
		version: 1,
		providers: {},
		settings: {},
	});

	const parser = (content: string): RelayConfig => {
		const parsed = JSON.parse(content);
		// Basic validation
		if (typeof parsed !== "object" || !parsed.providers) {
			throw new Error("Invalid config structure");
		}
		return parsed as RelayConfig;
	};

	const result = safeReadConfig(configPath, recovery, errorHandler, parser, emptyConfig);

	if (result.recoveredFrom) {
		console.log(`ai-gateway: Config recovered from backup`);
	}

	return result.data ?? emptyConfig();
}

/**
 * Safely write config with automatic backup
 */
export function writeConfigSafe(config: RelayConfig): boolean {
	const configPath = join(
		settingsDirectory(),
		"provider-ai.json"
	);

	const recovery = getConfigRecoveryInstance();
	const errorHandler = getErrorHandlerInstance();

	const content = JSON.stringify(config, null, 2);
	const result = safeWriteConfig(configPath, content, recovery, errorHandler);

	if (!result.success) {
		console.error("Failed to write config:", result.error?.message);
		return false;
	}

	return true;
}

/**
 * List all available config backups
 */
export function listConfigBackups(): Array<{ timestamp: number; path: string; age: string }> {
	const recovery = getConfigRecoveryInstance();
	const backups = recovery.listBackups();
	const now = Date.now();

	return backups.map(b => ({
		timestamp: b.timestamp,
		path: b.path,
		age: formatAge(now - b.timestamp),
	}));
}

/**
 * Restore config from a specific backup
 */
export function restoreFromBackup(timestamp: number): boolean {
	const recovery = getConfigRecoveryInstance();
	const backups = recovery.listBackups();
	const backup = backups.find(b => b.timestamp === timestamp);

	if (!backup) {
		console.error(`Backup with timestamp ${timestamp} not found`);
		return false;
	}

	const configPath = join(
		settingsDirectory(),
		"provider-ai.json"
	);

	const success = recovery.restore(backup, configPath);
	if (success) {
		console.log(`Config restored from backup: ${new Date(timestamp).toISOString()}`);
	}

	return success;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return `${seconds}s ago`;
}
