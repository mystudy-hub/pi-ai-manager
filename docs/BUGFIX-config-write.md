# 🐛 Bug Fix: writer.write is not a function

## 问题描述

**错误信息：**
```
TypeError: writer.write is not a function
    at writeConfig (C:/Users/maoju/.pi/agent/extensions/ai-gateway/config.ts:230:12)
```

**触发场景：**
- 用户在 `/ai-manager` TUI 中新增 provider 时
- 调用 `submitForm()` → `writeConfig()` 时出错

## 根本原因

`ConfigWriter` 类的 API 设计与调用方式不匹配：

**类定义（performance.ts）：**
```typescript
export class ConfigWriter {
    scheduleWrite(fn: () => void, delayMs = 500): void { ... }
    flush(): void { ... }
    cancel(): void { ... }
}
```

**错误的调用方式（config.ts 旧版本）：**
```typescript
const writer = new ConfigWriter(500);  // ❌ 构造函数不接受参数
writer.write(config);                   // ❌ 不存在 write 方法
```

## 修复方案

### 1. 修正 `config.ts` 中的使用方式

**修改前：**
```typescript
function getDebouncedWriter() {
    if (!debouncedWriter) {
        const { ConfigWriter } = require("./performance.ts");
        debouncedWriter = new ConfigWriter(500); // ❌ 错误
    }
    return debouncedWriter;
}

export function writeConfig(config: RelayConfig): void {
    const writer = getDebouncedWriter();
    if (writer) {
        writer.write(config);  // ❌ 不存在的方法
    } else {
        atomicWriteJson(configPath(), config);
    }
}
```

**修改后：**
```typescript
let debouncedWriter: any = null;
let pendingConfig: RelayConfig | null = null;

function getDebouncedWriter() {
    if (!debouncedWriter) {
        try {
            const { ConfigWriter } = require("./performance.ts");
            debouncedWriter = new ConfigWriter(); // ✅ 无参数
        } catch {
            return false; // ✅ 返回 false 表示不可用
        }
    }
    return debouncedWriter;
}

export function writeConfig(config: RelayConfig): void {
    // Backup config before writing
    try {
        const { getConfigRecoveryInstance } = require("./config-v2.ts");
        getConfigRecoveryInstance().backup(configPath());
    } catch {
        // config-v2.ts not available, skip backup
    }

    // Store pending config
    pendingConfig = config;

    // Use debounced writer if available
    const writer = getDebouncedWriter();
    if (writer) {
        writer.scheduleWrite(() => {  // ✅ 使用 scheduleWrite
            if (pendingConfig) {
                atomicWriteJson(configPath(), pendingConfig);
                pendingConfig = null;
            }
        }, 500);
    } else {
        // Direct write if debouncing not available
        atomicWriteJson(configPath(), config);
        pendingConfig = null;
    }
}

export function flushConfig(): void {
    const writer = getDebouncedWriter();
    if (writer) {
        writer.flush();  // ✅ 调用 flush 执行待处理的写入
    } else if (pendingConfig) {
        // Fallback: write pending config immediately
        atomicWriteJson(configPath(), pendingConfig);
        pendingConfig = null;
    }
}
```

### 2. 关键改进点

| 改进 | 说明 |
|------|------|
| ✅ 正确的 API 调用 | 使用 `scheduleWrite(fn, delay)` 而不是 `write(config)` |
| ✅ 无参构造函数 | `new ConfigWriter()` 不传参数 |
| ✅ 延迟参数移动 | 延迟时间（500ms）作为 `scheduleWrite` 的第二个参数 |
| ✅ 闭包捕获配置 | 通过 `pendingConfig` 变量捕获待写入的配置 |
| ✅ 降级方案 | 如果 `performance.ts` 不可用，直接写入 |
| ✅ 刷新逻辑 | `flushConfig()` 正确调用 `writer.flush()` |

## 测试验证

### 手动测试步骤

1. 启动 pi：
   ```bash
   pi
   ```

2. 进入 AI Gateway 管理：
   ```
   /ai-manager
   ```

3. 按 `n` 新增 provider

4. 填写表单：
   - Name: `test-provider`
   - Base URL: `https://api.example.com`
   - API Key: `test-key`

5. 提交表单 → 应该成功保存，不再报错

### 预期结果

- ✅ 配置成功写入 `~/.pi/ai-gateway/provider-ai.json`
- ✅ 自动创建备份文件（如果 `config-v2.ts` 可用）
- ✅ 写入操作被防抖（500ms 内多次写入只执行一次）
- ✅ 退出时自动刷新待处理的写入

## 影响范围

### 修改的文件

- `config.ts` (第 202-256 行)

### 受影响的功能

- ✅ 新增 provider
- ✅ 修改 provider 配置
- ✅ 启用/禁用模型
- ✅ 批量操作（auto-select, dedup, etc.）
- ✅ 所有需要保存配置的操作

## 向后兼容性

✅ **完全兼容** - 如果 `performance.ts` 不可用，会自动降级到直接写入模式。

## 性能优化

修复后的实现仍然保留了防抖优化：

- 连续写入操作会被合并
- 最多每 500ms 执行一次实际 I/O
- 退出时强制刷新确保数据不丢失

## 相关文件

- `config.ts` - 配置读写逻辑
- `performance.ts` - ConfigWriter 类定义
- `tui.ts` - TUI 界面，调用 writeConfig
- `config-v2.ts` - 配置备份和恢复（可选）

## 状态

✅ **已修复** - 2026-09-05

---

**修复者：** Claude  
**版本：** AI Gateway v3.1.1
