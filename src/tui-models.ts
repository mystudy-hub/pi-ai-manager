import type { CompiledOverride, HealthStatus, RelayApi, RelayModelMeta, RelayProviderEntry, TestResult } from "./types.ts";
import { HEALTH_TTL_MS } from "./types.ts";
import type { ModelQualityScore } from "./model-scoring.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildModelConfigs, modelLimits, modelReasoning } from "./provider.ts";
import { applyOverride, compileOverrides } from "./network.ts";
import { safeDisplay, safeError } from "./security.ts";
import { cell, type ViewTheme } from "./tui-layout.ts";
import { commandHint } from "./tui-commands.ts";

export interface ModelRow {
	id: string;
	enabled: boolean;
	testing: boolean;
	testResult?: TestResult;
	meta: RelayModelMeta;
	qualityScore?: ModelQualityScore;
}

const API_LABELS: Record<RelayApi, string> = {
	"anthropic-messages": "Anthropic", "openai-responses": "Responses", "openai-completions": "Completions",
};

export function effectiveHealth(health?: HealthStatus, now = Date.now()): HealthStatus["status"] {
	return !health?.lastCheck || now - health.lastCheck > HEALTH_TTL_MS ? "unknown" : health.status;
}

export function modelStatus(row: ModelRow): { text: string; color: "dim" | "success" | "warning" | "error" } {
	if (row.testing) return { text: "测试中", color: "warning" };
	if (row.testResult?.skipped || row.testResult?.total === 0) return { text: "跳过", color: "dim" };
	switch (effectiveHealth(row.meta.health)) {
		case "healthy": return { text: "正常", color: "success" };
		case "degraded": return { text: "部分通过", color: "warning" };
		case "down": return { text: "失败", color: "error" };
		default: return { text: row.meta.health?.lastCheck && Date.now() - row.meta.health.lastCheck > HEALTH_TTL_MS ? "已过期" : row.meta.health ? "未知" : "未测试", color: "dim" };
	}
}

function modelColumns(width: number): { name: number; protocol: number; reasoning: number; context: number; status: number; latency: number } {
	const latency = width >= 42 ? 9 : 0;
	const status = width >= 25 ? 8 : 0;
	// Keep at least 24 columns for the name when displaying all model settings.
	const protocol = width >= 80 ? 11 : 0;
	const reasoning = width >= 68 ? 6 : 0;
	const context = width >= 68 ? 10 : 0;
	const reserved = [protocol, reasoning, context, status, latency].reduce((sum, column) => sum + (column ? column + 1 : 0), 7);
	return { name: Math.max(1, width - reserved), protocol, reasoning, context, status, latency };
}

export function modelHeader(width: number): string {
	const columns = modelColumns(width);
	return cell(`  启用 ${cell("模型", columns.name)}` +
		(columns.protocol ? ` ${cell("协议", columns.protocol)}` : "") +
		(columns.reasoning ? ` ${cell("推理", columns.reasoning)}` : "") +
		(columns.context ? ` ${cell("上下文", columns.context)}` : "") +
		(columns.status ? ` ${cell("状态", columns.status)}` : "") +
		(columns.latency ? ` ${cell("延迟", columns.latency)}` : ""), width);
}

export function modelLine(row: ModelRow, entry: RelayProviderEntry, selected: boolean, width: number, theme: ViewTheme,
	rules: CompiledOverride[] = compileOverrides(entry.modelApiOverrides ?? {})): string {
	const columns = modelColumns(width);
	const status = modelStatus(row);
	const health = effectiveHealth(row.meta.health);
	const limits = columns.context ? modelLimits(entry, row.id) : undefined;
	// Old successful timings can still be inspected in details; do not attribute them to a failed run.
	const elapsed = !row.testing && (health === "healthy" || health === "degraded") && row.meta.metrics
		? `${Math.round(row.meta.metrics.avgResponseTime)}ms` : "—";
	const latencyText = elapsed !== "—" && health === "healthy" ? theme.fg("success", elapsed)
		: elapsed !== "—" && health === "degraded" ? theme.fg("warning", elapsed) : elapsed;
	const reasoningText = modelReasoning(entry, row.id) ? theme.fg("accent", "支持") : "不支持";
	const check = row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
	const name = cell(safeDisplay(row.id), columns.name);
	return cell(`${selected ? theme.fg("accent", ">") : " "} ${check}  ${selected ? theme.bold(name) : name}` +
		(columns.protocol ? ` ${cell(API_LABELS[applyOverride(row.id, row.meta.api, rules)], columns.protocol)}` : "") +
		(columns.reasoning ? ` ${cell(reasoningText, columns.reasoning)}` : "") +
		(limits ? ` ${cell((limits.estimated ? "约" : "") + limits.contextWindow.toLocaleString("en-US"), columns.context)}` : "") +
		(columns.status ? ` ${cell(theme.fg(status.color, status.text), columns.status)}` : "") +
		(columns.latency ? ` ${cell(latencyText, columns.latency)}` : ""), width);
}

/** Keep all model settings and their editing keys visible when table columns are hidden. */
export function modelSettingsLines(entry: RelayProviderEntry, row: ModelRow, width: number,
	rules: CompiledOverride[] = compileOverrides(entry.modelApiOverrides ?? {})): string[] {
	const limits = modelLimits(entry, row.id);
	const protocol = `${commandHint("protocol")}：${API_LABELS[applyOverride(row.id, row.meta.api, rules)]}`;
	const protocolWithSource = protocol + (rules.some(rule => rule.regex.test(row.id)) ? "（规则）" : "（自动）");
	const hints = [
		visibleWidth(protocolWithSource) <= width ? protocolWithSource : protocol,
		`${commandHint("reasoning")}：${modelReasoning(entry, row.id) ? "支持" : "不支持"}`,
		`${commandHint("context")}：${limits.estimated ? "约" : ""}${limits.contextWindow.toLocaleString("en-US")}`,
	];
	const lines: string[] = [];
	for (const hint of hints) {
		const previous = lines.at(-1);
		if (previous && visibleWidth(previous + "  " + hint) <= width) lines[lines.length - 1] = previous + "  " + hint;
		else lines.push(hint);
	}
	return lines;
}

export function recordTime(time?: number): string {
	return time && Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "无记录";
}

/** Full, wrappable details; no keys, raw remote errors or implicit zero prices. */
export function modelDetails(gateway: string, entry: RelayProviderEntry, row: ModelRow, secrets: readonly string[]): string[] {
	const model = buildModelConfigs(entry, [row.id])[0];
	const limits = modelLimits(entry, row.id);
	const pinned = compileOverrides(entry.modelApiOverrides ?? {}).some(rule => rule.regex.test(row.id));
	const lines = [
		`模型 ID：${safeDisplay(row.id)}`,
		`网关：${safeDisplay(gateway)} · ${row.enabled ? "已启用" : "未启用"}`,
		`协议：${model?.api ?? row.meta.api}（${pinned ? "手工规则" : "自动 / 发现"}；p 切换）`,
		`上下文：${limits.contextWindow.toLocaleString("en-US")} tokens${limits.estimated ? "（估算）" : ""}（C 修改）`,
		`最大输出：${limits.maxTokens.toLocaleString("en-US")} tokens`,
		`推理声明：${model?.reasoning ? "支持" : "不支持"}（g/b 切换）`,
		`输入：${model?.input.join(" / ") ?? "text"}`,
		row.meta.cost
			? `价格 / 百万 token：输入 ${row.meta.cost.input}，输出 ${row.meta.cost.output}，缓存读 ${row.meta.cost.cacheRead}，缓存写 ${row.meta.cost.cacheWrite}`
			: "价格：未知（未配置价格）",
		`状态：${modelStatus(row).text}；检查时间：${recordTime(row.meta.health?.lastCheck)}`,
	];
	if (row.meta.metrics) {
		const metrics = row.meta.metrics;
		lines.push(`成功请求延迟：平均 ${metrics.avgResponseTime}ms，最短 ${metrics.minResponseTime}ms，最长 ${metrics.maxResponseTime}ms`);
		lines.push(`指标时间：${recordTime(metrics.timestamp)}${metrics.avgTokens === undefined ? "" : `；平均用量 ${metrics.avgTokens} tokens`}`);
	}
	if (row.testResult) {
		const result = row.testResult;
		lines.push(`本次会话最近测试：${result.skipped || result.total === 0 ? "跳过，未发送请求" : `${result.passed}/${result.total} 通过`}`);
		for (const reason of result.reasons) lines.push(`原因：${safeError(reason, secrets)}`);
		if (result.reasons.some(reason => /\b(401|403)\b|unauthori[sz]ed|authentication|invalid.api.key/i.test(reason))) {
			lines.push("建议：核对网关实际使用的凭据来源；Pi 登录和运行时凭据优先于配置密钥。");
		}
	} else if (row.meta.health?.status === "down" || row.meta.health?.status === "degraded") {
		lines.push("失败原因未保存在配置中；本次会话测试后可查看。");
	}
	if (row.qualityScore) lines.push(`名称推荐分：${row.qualityScore.recommendScore}（启发式参考）`);
	return lines;
}
