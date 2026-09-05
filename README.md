# pi-ai-manager 🚀

[![Pi Package](https://img.shields.io/badge/pi-package-blue.svg)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.1.3-green.svg)](https://github.com/mystudy-hub/pi-ai-manager)

**pi-ai-manager**（AI Gateway & Model Manager）是为 [Pi Coding Agent](https://github.com/earendil-works/pi) 打造的交互式 AI 中继网关与模型管理扩展。

通过交互式 TUI 界面（命令 `/ai-manager`），你可以轻松添加各大中继服务商、自动嗅探兼容协议、拉取和测试可用模型、智能去重与推荐、一键启用并即时同步到 Pi 中使用。

---

## ✨ 核心特性

- 🖥️ **交互式双栏 TUI**：左侧网关列表，右侧模型列表，状态与快捷键一目了然。
- 🔍 **协议自动嗅探**：支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Gemini 等主流协议自适应。
- ⚡ **模型批量测速**：单个测试 (`t`)、全部测试 (`T`)、按类别聚合测试 (`A`)，实时显示延迟和可用状态。
- 🎯 **智能推荐与去重**：
  - 自动根据模型综合质量与速度推荐最佳模型组合（`a`）。
  - 智能识别同名/同类模型并保留速度最优者（`d`）。
- ↩️ **50 级多步撤销**：批量操作误触无需慌张，按 `u` 键即可一键撤销（支持自动选择、去重、通配符等）。
- 🛡️ **数据安全与自动备份**：
  - 每次配置保存前自动备份，异常时自动安全回滚。
  - Windows/Linux/macOS 跨平台原子写入，解决 Windows fsync 兼容性问题。
- 🚀 **极致性能优化**：内置防抖写入、虚拟化渲染、智能缓存，即便面对 10,000+ 超大模型列表依然丝滑流畅。

---

## 📦 安装方法

### 方式 1：使用 Pi 包管理器直接安装（推荐）

```bash
# 全局安装
pi install git:github.com/mystudy-hub/pi-ai-manager

# 或在当前项目内安装
pi install -l git:github.com/mystudy-hub/pi-ai-manager
```

### 方式 2：本地扩展目录引入

克隆本仓库到本地扩展目录：

```bash
git clone https://github.com/mystudy-hub/pi-ai-manager.git ~/.pi/agent/extensions/ai-gateway
```

启动 Pi 即可自动加载。

---

## 🎮 使用指南

在 Pi 终端对话中输入命令启动管理界面：

```bash
# 打开交互式管理界面
/ai-manager

# 或直接打开指定名称的网关进行管理
/ai-manager my-gateway
```

### 快捷键一览

#### 🗂️ 网关管理（左栏焦点）

| 快捷键 | 功能描述 |
| :--- | :--- |
| `n` | 新建中继网关（输入名称、Base URL、API Key） |
| `D` | 删除当前选中的网关 |
| `r` | 重新拉取当前网关的模型列表 |
| `R` | 强制刷新全部网关模型缓存 |
| `Tab` / `→` | 切换焦点到右侧模型列表 |
| `Enter` / `Ctrl+S` | 保存修改并生效配置 |
| `Esc` / `q` | 退出管理器 |

#### 🤖 模型管理（右栏焦点）

| 快捷键 | 功能描述 |
| :--- | :--- |
| `Space` | 勾选 / 取消勾选当前模型（启用后即可在 Pi 中直接使用） |
| `t` | 测试当前选中的模型连通性与响应延时 |
| `T` | 测试当前网关的所有已启用模型 |
| `A` | 测试所有发现的模型 |
| `p` | 循环切换模型的 API 协议适配格式 |
| `a` | **Auto**：按评分规则自动推荐并启用高质量模型组合 |
| `d` | **Dedup**：自动去重，禁用重复且较慢的模型 |
| `e` | **Enable Pattern**：按正则表达式/通配符批量启用模型（如 `gpt-*`） |
| `x` | **Disable Pattern**：按正则表达式/通配符批量禁用模型 |
| `u` | **Undo**：撤销上一次批量操作（最多支持 50 步） |
| `/` | 实时搜索过滤模型名称 |
| `s` | 切换排序方式（名称 / 延时 / 启用状态） |
| `q` | 质量评分视图切换 |
| `Tab` / `←` | 返回左侧网关列表 |

---

## 🏗️ 架构与源码说明

```
pi-ai-manager/
├── src/
│   ├── index.ts              # 扩展主入口，注册 providers 和 /ai-manager 命令
│   ├── commands.ts           # /ai-manager 命令处理与交互入口
│   ├── tui.ts                # TUI 核心控制器
│   ├── tui-state.ts          # TUI 状态容器与操作撤销栈（OperationHistory）
│   ├── tui-renderer.ts       # TUI 纯渲染逻辑
│   ├── tui-handlers.ts       # 键盘交互与事件路由
│   ├── tui-input.ts          # 文本输入框与表单处理
│   ├── config.ts             # 配置加载、原子写入与防抖落盘
│   ├── config-v2.ts          # 配置备份容灾与恢复机制
│   ├── provider.ts           # 动态向 Pi 注册适配的 Model Provider
│   ├── api-detect.ts         # 自动协议嗅探
│   ├── network.ts            # 模型列表请求与网络适配
│   ├── testing.ts            # 模型可用性探针与测速
│   ├── performance.ts        # 高性能防抖写入、缓存机制
│   ├── dedup.ts              # 模型智能去重算法
│   ├── model-scoring.ts      # 模型评分模型与分类排序
│   ├── error-handler.ts      # 统一错误捕获与降级处理
│   ├── types.ts              # 全局数据模型与类型声明
│   └── utils.ts              # 通用辅助工具
├── docs/                     # 详细文档与开发报告
└── tests/                    # 单元测试与集成验证脚本
```

---

## 📚 详细文档

- [快速入门教程 (Quick Start)](docs/QUICK-START-v3.1.md)
- [v3.1 架构与性能改进报告](docs/IMPROVEMENTS-v3.1.md)
- [版本发布与更新日志 (Changelog)](docs/CHANGELOG.md)
- [Windows fsync 兼容性修复记录](docs/BUGFIX-windows-fsync.md)

---

## 🤝 贡献与开源协议

欢迎提交 Issue 和 Pull Request！

本项目遵循 [MIT License](LICENSE)。
