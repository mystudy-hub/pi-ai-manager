import type { RelayConfig, RelayModelMeta, RelayProviderEntry } from "./types.ts";
import { safeDisplay } from "./security.ts";

export interface DraftChange {
	kind: "config" | "test" | "discovery";
	text: string;
}

export interface DraftSummary {
	changes: DraftChange[];
	config: number;
	test: number;
	discovery: number;
	total: number;
}

// Object ordering and absent optional properties are not user changes.
function comparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(comparable);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
		.filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => [key, comparable(item)]));
	return value;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

const MODEL_FIELDS: Partial<Record<keyof RelayModelMeta, string>> = {
	api: "协议", discoveredApi: "发现协议", contextWindow: "上下文", maxTokens: "输出上限",
	cost: "价格", reasoning: "推理声明", thinkingLevelMap: "推理等级", thinkingMode: "推理模式",
	thinkingEffort: "推理强度", compat: "兼容选项", input: "输入类型",
};

function credentialSource(entry: RelayProviderEntry): string {
	return entry.apiKeyEnv ? "环境变量" : entry.apiKey ? "配置密钥" : "Pi 凭据";
}

function modelFieldChange(before: RelayModelMeta, after: RelayModelMeta, field: keyof RelayModelMeta): string {
	const label = MODEL_FIELDS[field];
	if (["api", "discoveredApi", "contextWindow", "maxTokens"].includes(field)) return `${label} ${before[field] ?? "自动"} → ${after[field] ?? "自动"}`;
	if (field === "reasoning") {
		const show = (value?: boolean) => value === undefined ? "自动" : value ? "支持" : "不支持";
		return `${label} ${show(before.reasoning)} → ${show(after.reasoning)}`;
	}
	return `${label}已修改`;
}

/** Compare with the saved baseline, never with the undo stack. Secret values are never formatted. */
export function summarizeDraft(baseline: RelayConfig, draft: RelayConfig): DraftSummary {
	const changes: DraftChange[] = [];
	const add = (kind: DraftChange["kind"], text: string) => changes.push({ kind, text: safeDisplay(text) });
	for (const name of new Set([...Object.keys(baseline.providers), ...Object.keys(draft.providers)])) {
		const before = baseline.providers[name];
		const after = draft.providers[name];
		if (!before || !after) {
			add("config", `${name}：${after ? `新增网关（${after.enabledModels.length}/${Object.keys(after.models).length} 个模型启用）` : "删除网关"}`);
			if (after) {
				for (const [id, meta] of Object.entries(after.models)) {
					if (meta.health || meta.metrics) add("test", `${name} / ${id}：新增健康与延迟记录`);
				}
				const refreshed = Object.values(after.models).filter(meta => meta.lastDiscovered !== undefined).length;
				if (refreshed) add("discovery", `${name}：${refreshed} 个模型的发现记录已更新`);
			}
			continue;
		}
		if (before.baseUrl !== after.baseUrl) add("config", `${name}：连接地址已修改`);
		if (before.apiKey !== after.apiKey || before.apiKeyEnv !== after.apiKeyEnv) {
			add("config", `${name}：凭据已修改（${credentialSource(before)} → ${credentialSource(after)}；值隐藏）`);
		}
		if (before.defaultApi !== after.defaultApi) add("config", `${name}：默认协议 ${before.defaultApi} → ${after.defaultApi}`);
		if (!!before.allowInsecureHttp !== !!after.allowInsecureHttp) add("config", `${name}：HTTP 许可已修改`);
		// First matching rule wins, so a change in rule order is a real routing change.
		if (!same(Object.entries(before.modelApiOverrides ?? {}), Object.entries(after.modelApiOverrides ?? {}))) add("config", `${name}：模型协议规则已修改`);
		const wasEnabled = new Set(before.enabledModels);
		const isEnabled = new Set(after.enabledModels);
		for (const id of new Set([...wasEnabled, ...isEnabled])) {
			if (wasEnabled.has(id) !== isEnabled.has(id)) add("config", `${name} / ${id}：${isEnabled.has(id) ? "启用" : "禁用"}`);
		}
		let discovered = 0;
		for (const id of new Set([...Object.keys(before.models), ...Object.keys(after.models)])) {
			const old = before.models[id];
			const next = after.models[id];
			if (!old || !next) {
				add("config", `${name} / ${id}：${next ? "新增模型" : "移除模型"}`);
			} else {
				const fields = (Object.keys(MODEL_FIELDS) as (keyof RelayModelMeta)[]).filter(key => !same(old[key], next[key]));
				if (fields.length) add("config", `${name} / ${id}：${fields.map(key => modelFieldChange(old, next, key)).join("；")}`);
			}
			if (next && (!same(old?.health, next.health) || !same(old?.metrics, next.metrics))) add("test", `${name} / ${id}：健康与延迟记录已更新`);
			if (next?.lastDiscovered !== old?.lastDiscovered) discovered++;
		}
		if (discovered) add("discovery", `${name}：${discovered} 个模型的发现记录已更新`);
	}
	if (!same(baseline.settings, draft.settings)) add("config", "测试设置已修改");
	return {
		changes, total: changes.length,
		config: changes.filter(change => change.kind === "config").length,
		test: changes.filter(change => change.kind === "test").length,
		discovery: changes.filter(change => change.kind === "discovery").length,
	};
}
