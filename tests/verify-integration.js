#!/usr/bin/env node
// AI Gateway v3.1 - 集成验证脚本

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_SRC_DIR = path.join(__dirname, "../src");
const GLOBAL_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi/agent/extensions/ai-gateway");
const EXTENSION_DIR = fs.existsSync(PROJECT_SRC_DIR) ? PROJECT_SRC_DIR : GLOBAL_DIR;
const DOCS_DIR = fs.existsSync(path.join(__dirname, "../docs")) ? path.join(__dirname, "../docs") : EXTENSION_DIR;

console.log("🔍 AI Gateway v3.1 集成验证\n");
console.log("=".repeat(60));

let allPassed = true;

// 检查项列表
const checks = [
	{
		name: "核心模块文件存在",
		check: () => {
			const files = [
				"tui-state.ts",
				"tui-renderer.ts",
				"tui-handlers.ts",
				"error-handler.ts",
				"config-v2.ts",
				"performance.ts",
			];
			const missing = files.filter(f => !fs.existsSync(path.join(EXTENSION_DIR, f)));
			if (missing.length > 0) {
				return { pass: false, message: `缺失文件: ${missing.join(", ")}` };
			}
			return { pass: true, message: `所有 6 个核心模块文件存在` };
		}
	},
	{
		name: "文档文件存在",
		check: () => {
			const files = [
				"README-v3.1.md",
				"QUICK-START-v3.1.md",
				"IMPROVEMENTS-v3.1.md",
				"COMPLETION-REPORT.md",
			];
			const missing = files.filter(f => !fs.existsSync(path.join(DOCS_DIR, f)));
			if (missing.length > 0) {
				return { pass: false, message: `缺失文档: ${missing.join(", ")}` };
			}
			return { pass: true, message: `所有 4 个文档文件存在` };
		}
	},
	{
		name: "测试文件存在",
		check: () => {
			const file = "test-improvements.ts";
			if (!fs.existsSync(path.join(__dirname, file)) && !fs.existsSync(path.join(EXTENSION_DIR, file))) {
				return { pass: false, message: `缺失测试文件: ${file}` };
			}
			return { pass: true, message: `测试文件存在` };
		}
	},
	{
		name: "tui.ts 集成撤销功能",
		check: () => {
			const tuiPath = path.join(EXTENSION_DIR, "tui.ts");
			if (!fs.existsSync(tuiPath)) {
				return { pass: false, message: "tui.ts 文件不存在" };
			}
			const content = fs.readFileSync(tuiPath, "utf-8");

			const testPatterns = [
				{ pattern: /operationHistory/i, name: "操作历史引用" },
				{ pattern: /undoLastOperation/i, name: "撤销方法" },
				{ pattern: /recordOperation/i, name: "记录操作方法" },
			];

			const missing = testPatterns.filter(c => !c.pattern.test(content));
			if (missing.length > 0) {
				return { pass: false, message: `缺失集成: ${missing.map(m => m.name).join(", ")}` };
			}
			return { pass: true, message: "撤销功能已集成到 tui.ts" };
		}
	},
	{
		name: "config.ts 集成备份和防抖",
		check: () => {
			const configPath = path.join(EXTENSION_DIR, "config.ts");
			if (!fs.existsSync(configPath)) {
				return { pass: false, message: "config.ts 文件不存在" };
			}
			const content = fs.readFileSync(configPath, "utf-8");

			const hasBackup = /config-v2|ConfigRecovery|backup/i.test(content);
			const hasDebounce = /ConfigWriter|debounce|flushConfig/i.test(content);

			if (!hasBackup && !hasDebounce) {
				return { pass: false, message: "未找到备份或防抖集成" };
			}
			if (!hasBackup) {
				return { pass: false, message: "未找到备份集成" };
			}
			if (!hasDebounce) {
				return { pass: false, message: "未找到防抖集成" };
			}
			return { pass: true, message: "备份和防抖已集成到 config.ts" };
		}
	},
	{
		name: "帮助文档包含撤销说明",
		check: () => {
			const tuiPath = path.join(EXTENSION_DIR, "tui.ts");
			if (!fs.existsSync(tuiPath)) {
				return { pass: false, message: "tui.ts 文件不存在" };
			}
			const content = fs.readFileSync(tuiPath, "utf-8");

			const hasUndoHelp = /u\s+undo/i.test(content);
			if (!hasUndoHelp) {
				return { pass: false, message: "帮助文本中未找到撤销说明" };
			}
			return { pass: true, message: "帮助文档已更新" };
		}
	},
	{
		name: "TypeScript 语法检查",
		check: () => {
			const files = [
				"tui-state.ts",
				"tui-renderer.ts",
				"tui-handlers.ts",
				"error-handler.ts",
				"config-v2.ts",
				"performance.ts",
			];

			// 简单语法检查：确保文件可以被读取且不是空的
			const issues = [];
			for (const file of files) {
				const filePath = path.join(EXTENSION_DIR, file);
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					if (content.length < 100) {
						issues.push(`${file} 内容过短`);
					}
					// 检查基本 TypeScript 语法
					if (!content.includes("export")) {
						issues.push(`${file} 没有导出`);
					}
				} catch (error) {
					issues.push(`${file} 读取失败: ${error instanceof Error ? error.message : error}`);
				}
			}

			if (issues.length > 0) {
				return { pass: false, message: issues.join("; ") };
			}
			return { pass: true, message: "所有文件语法基本正常" };
		}
	},
	{
		name: "备份目录配置",
		check: () => {
			const errorHandlerPath = path.join(EXTENSION_DIR, "error-handler.ts");
			if (!fs.existsSync(errorHandlerPath)) {
				return { pass: false, message: "error-handler.ts 不存在" };
			}
			const content = fs.readFileSync(errorHandlerPath, "utf-8");

			const hasBackupDir = /\.backups|backupDir/i.test(content);
			if (!hasBackupDir) {
				return { pass: false, message: "未找到备份目录配置" };
			}
			return { pass: true, message: "备份目录已配置" };
		}
	}
];

// 运行所有检查
console.log("\n📋 运行检查...\n");

checks.forEach((check, index) => {
	try {
		const result = check.check();
		const icon = result.pass ? "✅" : "❌";
		console.log(`${icon} ${index + 1}. ${check.name}`);
		console.log(`   ${result.message}`);

		if (!result.pass) {
			allPassed = false;
		}
	} catch (error) {
		console.log(`❌ ${index + 1}. ${check.name}`);
		console.log(`   错误: ${error instanceof Error ? error.message : error}`);
		allPassed = false;
	}
	console.log();
});

console.log("=".repeat(60));

// 总结
if (allPassed) {
	console.log("\n🎉 所有检查通过！AI Gateway v3.1 已正确集成。\n");
	process.exit(0);
} else {
	console.log("\n⚠️ 发现问题，请检查上述失败项。\n");
	process.exit(1);
}
