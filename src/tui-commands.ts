import { Key, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { FilterMode, QualityFilter, SortMode } from "./types.ts";
import { fitHints } from "./tui-layout.ts";

export const FILTER_LABELS: Record<FilterMode, string> = { all: "全部", enabled: "已启用", healthy: "健康", untested: "未测/过期" };
export const QUALITY_LABELS: Record<QualityFilter, string> = { all: "全部", recommended: "推荐", strict: "严格" };
export const SORT_LABELS: Record<SortMode, string> = { enabled: "启用优先", name: "名称", status: "健康", performance: "延迟" };

interface CommandDefinition {
	id: string;
	keys: readonly KeyId[];
	keyHint: string;
	label: string;
	short: string;
	group: string;
	pane?: "models" | "gateways";
	needs?: "model" | "gateway" | "history" | "task";
	readOnly?: boolean;
}

/** Both shortcuts and the action menu dispatch these IDs; help and footer use the same labels. */
export const COMMANDS = [
	{ id: "toggle", keys: [Key.space], keyHint: "Space", label: "切换模型启用", short: "切换", group: "模型", pane: "models", needs: "model" },
	{ id: "details", keys: ["i"], keyHint: "i", label: "查看选中项详情", short: "详情", group: "查看", needs: "gateway", readOnly: true },
	{ id: "test", keys: ["t"], keyHint: "t", label: "测试当前模型（发出请求）", short: "测试", group: "模型", pane: "models", needs: "model" },
	{ id: "test-visible", keys: [Key.shift("t")], keyHint: "T", label: "测试筛选后的全部模型（先确认）", short: "批量测试", group: "批量", needs: "gateway" },
	{ id: "protocol", keys: ["p"], keyHint: "p", label: "切换协议 auto / Anthropic / Responses / Completions", short: "协议", group: "模型", pane: "models", needs: "model" },
	{ id: "reasoning", keys: ["g", "b"], keyHint: "g/b", label: "切换推理能力声明", short: "推理", group: "模型", pane: "models", needs: "model" },
	{ id: "context", keys: [Key.shift("c")], keyHint: "C", label: "设置上下文窗口", short: "上下文", group: "模型", pane: "models", needs: "model" },
	{ id: "compare", keys: ["c"], keyHint: "c", label: "比较各网关已有记录（无请求）", short: "比较", group: "查看", pane: "models", needs: "model", readOnly: true },
	{ id: "auto", keys: ["a"], keyHint: "a", label: "补充推荐模型，保留已有选择", short: "推荐", group: "批量", needs: "gateway" },
	{ id: "dedup", keys: ["d"], keyHint: "d", label: "当前网关内去重", short: "去重", group: "批量", pane: "models", needs: "gateway" },
	{ id: "enable-pattern", keys: ["e"], keyHint: "e", label: "按 glob 批量启用", short: "按模式启用", group: "批量", needs: "gateway" },
	{ id: "disable-pattern", keys: ["x"], keyHint: "x", label: "按 glob 批量禁用", short: "按模式禁用", group: "批量", needs: "gateway" },
	{ id: "undo", keys: ["u"], keyHint: "u", label: "撤销最近修改", short: "撤销", group: "保存", needs: "history" },
	{ id: "add", keys: ["n"], keyHint: "n", label: "新增网关", short: "新增", group: "网关" },
	{ id: "edit", keys: [Key.shift("e")], keyHint: "E", label: "编辑网关", short: "编辑", group: "网关", needs: "gateway" },
	{ id: "delete", keys: [Key.shift("d")], keyHint: "D", label: "删除网关（先确认，也可 dd）", short: "删除", group: "网关", pane: "gateways", needs: "gateway" },
	{ id: "refresh", keys: ["r"], keyHint: "r", label: "从中转站更新支持的模型 (同步远程最新模型)", short: "更新模型", group: "同步", needs: "gateway" },
	{ id: "refresh-all", keys: [Key.shift("r")], keyHint: "R", label: "从中转站更新所有网关模型", short: "全部更新", group: "同步", needs: "gateway" },
	{ id: "test-all", keys: [Key.shift("a")], keyHint: "A", label: "测试所有网关的已启用模型（先确认）", short: "测试全部网关", group: "批量", needs: "gateway" },
	{ id: "search", keys: ["/"], keyHint: "/", label: "搜索模型名称", short: "搜索", group: "查看", readOnly: true },
	{ id: "filters", keys: ["f"], keyHint: "f", label: "选择状态 / 质量筛选或重置搜索", short: "筛选", group: "查看", readOnly: true },
	{ id: "quality", keys: ["q"], keyHint: "q", label: "切换全部 / 推荐 / 严格质量筛选", short: "质量", group: "查看", readOnly: true },
	{ id: "sort", keys: ["s"], keyHint: "s", label: "切换名称 / 健康 / 延迟 / 启用优先排序", short: "排序", group: "查看", readOnly: true },
	{ id: "changes", keys: ["v"], keyHint: "v", label: "查看未保存的配置和记录", short: "变更", group: "保存", readOnly: true },
	{ id: "actions", keys: [":"], keyHint: ":", label: "搜索操作菜单", short: "操作", group: "查看", readOnly: true },
	{ id: "help", keys: ["?"], keyHint: "?", label: "查看快捷键帮助", short: "帮助", group: "查看", readOnly: true },
	{ id: "stop", keys: [Key.ctrl("c")], keyHint: "Ctrl+C", label: "停止当前任务，保留草稿和已完成记录", short: "停止任务", group: "任务", needs: "task", readOnly: true },
	{ id: "save", keys: [Key.enter, Key.ctrl("s")], keyHint: "Enter", label: "保存草稿并退出（也可 Ctrl+S）", short: "保存退出", group: "保存", readOnly: true },
	{ id: "discard", keys: [Key.escape], keyHint: "Esc", label: "放弃草稿并退出；任务进行中只停止任务", short: "放弃退出", group: "保存", readOnly: true },
] as const satisfies readonly CommandDefinition[];

export type CommandId = typeof COMMANDS[number]["id"];
export type Command = CommandDefinition & { id: CommandId };

/** Keep all per-model settings available in both the main view and details. */
export const MODEL_SETTING_COMMANDS = ["protocol", "reasoning", "context"] as const satisfies readonly CommandId[];

export function commandForInput(data: string, pane: "models" | "gateways"): Command | undefined {
	return (COMMANDS as readonly Command[]).find(command => (!command.pane || command.pane === pane) &&
		command.keys.some(key => matchesKey(data, key)));
}

export function commandHint(id: CommandId): string {
	const command = COMMANDS.find(command => command.id === id)!;
	return `${command.keyHint} ${command.short}`;
}

export function browseFooter(width: number, pane: "models" | "gateways", running: boolean): string[] {
	const ids: CommandId[] = pane === "models"
		? ["toggle", "refresh", "details", "filters", "search", "help"]
		: ["add", "refresh", "edit", "details", "delete", "help"];
	const actions = fitHints([commandHint("actions"), ...(pane === "models" ? MODEL_SETTING_COMMANDS.map(commandHint) : []),
		"Tab 切栏", ...ids.map(commandHint), "↑↓ 移动"], width);
	const save = running ? "Enter 停止并保存" : commandHint("save");
	const leave = running ? "Esc 停止任务" : commandHint("discard");
	const critical = width >= 34 ? fitHints([save, leave, ...(running ? [commandHint("stop")] : [commandHint("undo"), commandHint("changes")])], width)
		: width >= 19 ? `Enter保存 Esc${running ? "停止" : "放弃"}` : `↵存 Esc${running ? "停" : "弃"}`;
	return [actions, critical];
}

export function dialogFooter(width: number, apply: string, leave = "取消"): string {
	if (width >= 30) return `Enter ${apply}  Esc ${leave}`;
	if (width >= 19) return `Enter${apply.slice(0, 2)} Esc${leave.slice(0, 2)}`;
	return `↵${apply.slice(0, 1)} Esc${leave.slice(0, 1)}`;
}

export const HELP_TEXT: readonly string[] = [
	"导航：↑↓ / PgUp / PgDn / Home / End 移动；←→ / Tab 切换网关、模型。",
	"窄窗口只显示当前栏。默认显示全部模型，已启用优先。",
	"模型栏显示当前接入协议、推理声明和上下文长度；约表示估算值。p、g/b、C 在模型详情页也可使用。",
	"p 只修改选中模型的协议；auto 清除该模型的固定协议后，仍遵循网关规则和发现结果。",
	...COMMANDS.map(command => `${command.keyHint}  ${command.label}`),
	"表单：Tab / Shift+Tab / ↑↓ 切字段；Enter 下一项，在 API 字段应用。",
	"文本：←→ 移动光标；Home / End 到首尾；Delete / Backspace 删除；Ctrl+U 清空。",
	"Esc 在子页面返回，在主页面放弃；测试/发现进行中只停止任务。Ctrl+C 可从任意页面停止任务。",
	"未保存项按当前草稿与打开时的配置比较；配置修改、测试记录和发现记录分别列出。",
];

export interface MenuItem {
	id: string;
	label: string;
	hint: string;
	enabled: boolean;
	checked?: boolean;
}
