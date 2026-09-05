# ✅ AI Gateway v3.1.1 验证清单

## 修复验证：writer.write is not a function

### 1️⃣ 代码静态检查

- [x] `config.ts` 使用 `scheduleWrite()` 而不是 `write()`
- [x] `ConfigWriter` 构造函数无参数调用
- [x] `pendingConfig` 变量正确捕获配置
- [x] `flushConfig()` 正确调用 `writer.flush()`
- [x] 降级方案存在（直接写入）

### 2️⃣ 功能测试

#### 测试场景 A: 新增 Provider

```bash
pi
/ai-manager
按 'n' 键
填写表单：
  Name: test-provider
  Base URL: https://api.example.com
  API Key: test-key
提交
```

**预期结果：**
- [ ] 没有 `writer.write is not a function` 错误
- [ ] Provider 成功添加到列表
- [ ] 配置文件已更新

#### 测试场景 B: 启用/禁用模型

```bash
/ai-manager
选择一个 provider
按空格键启用/禁用模型
按 's' 保存
```

**预期结果：**
- [ ] 模型状态成功切换
- [ ] 没有写入错误
- [ ] 配置持久化

#### 测试场景 C: 批量操作

```bash
/ai-manager
按 'a' 自动选择模型
按 'd' 去重模型
```

**预期结果：**
- [ ] 批量操作成功
- [ ] 可以按 'u' 撤销
- [ ] 配置正确保存

#### 测试场景 D: 防抖验证

```bash
/ai-manager
快速启用/禁用多个模型（连续操作）
等待 1 秒
检查磁盘写入次数
```

**预期结果：**
- [ ] 多次操作只触发一次实际写入
- [ ] 最终状态正确保存

#### 测试场景 E: 退出时刷新

```bash
/ai-manager
修改配置
立即按 'q' 退出（不等待）
重新打开检查配置
```

**预期结果：**
- [ ] 退出时自动刷新写入
- [ ] 配置没有丢失
- [ ] 重新打开后状态正确

### 3️⃣ 错误处理

#### 测试场景 F: performance.ts 不可用

```bash
# 临时重命名 performance.ts
mv ~/.pi/agent/extensions/ai-gateway/performance.ts{,.bak}
pi
/ai-manager
新增 provider
```

**预期结果：**
- [ ] 降级到直接写入模式
- [ ] 功能正常工作
- [ ] 没有崩溃

```bash
# 恢复文件
mv ~/.pi/agent/extensions/ai-gateway/performance.ts{.bak,}
```

#### 测试场景 G: config-v2.ts 不可用

```bash
# 临时重命名 config-v2.ts
mv ~/.pi/agent/extensions/ai-gateway/config-v2.ts{,.bak}
pi
/ai-manager
修改配置
```

**预期结果：**
- [ ] 跳过备份步骤
- [ ] 配置仍然正常保存
- [ ] 没有错误

```bash
# 恢复文件
mv ~/.pi/agent/extensions/ai-gateway/config-v2.ts{.bak,}
```

### 4️⃣ 性能测试

#### 测试场景 H: 大量写入

```bash
/ai-manager
连续 10 次启用/禁用模型（间隔 < 100ms）
观察磁盘 I/O
```

**预期指标：**
- [ ] 实际写入次数 ≤ 3 次
- [ ] 最终状态正确
- [ ] 没有性能问题

### 5️⃣ 兼容性测试

#### 测试场景 I: 旧配置迁移

```bash
# 使用旧版本的配置文件
cp ~/.pi/ai-gateway/provider-ai.json{,.backup}
# 打开新版本
pi
/ai-manager
```

**预期结果：**
- [ ] 旧配置正确加载
- [ ] 新功能正常工作
- [ ] 保存后格式兼容

---

## 快速验证命令

```bash
# 1. 检查文件存在
ls -lh ~/.pi/agent/extensions/ai-gateway/{config,performance,config-v2}.ts

# 2. 检查关键代码
grep "scheduleWrite" ~/.pi/agent/extensions/ai-gateway/config.ts
grep "pendingConfig" ~/.pi/agent/extensions/ai-gateway/config.ts
grep "flushConfig" ~/.pi/agent/extensions/ai-gateway/config.ts

# 3. 检查类定义
grep -A 3 "export class ConfigWriter" ~/.pi/agent/extensions/ai-gateway/performance.ts

# 4. 启动并测试
pi
# 输入: /ai-manager
# 按 'n' 新增 provider
# 填写并提交
```

---

## 验证状态

| 测试场景 | 状态 | 测试者 | 日期 |
|---------|------|--------|------|
| A: 新增 Provider | ⏳ 待测试 | | |
| B: 启用/禁用模型 | ⏳ 待测试 | | |
| C: 批量操作 | ⏳ 待测试 | | |
| D: 防抖验证 | ⏳ 待测试 | | |
| E: 退出时刷新 | ⏳ 待测试 | | |
| F: performance.ts 不可用 | ⏳ 待测试 | | |
| G: config-v2.ts 不可用 | ⏳ 待测试 | | |
| H: 大量写入 | ⏳ 待测试 | | |
| I: 旧配置迁移 | ⏳ 待测试 | | |

状态说明：
- ⏳ 待测试
- ✅ 通过
- ❌ 失败
- ⚠️ 部分通过

---

## 如果测试失败

### 问题 1: 仍然报 writer.write 错误

**可能原因：**
- 缓存了旧版本的 require
- 需要重启 pi

**解决方法：**
```bash
# 完全退出 pi
# 清理可能的缓存
rm -rf ~/.pi/agent/extensions/ai-gateway/node_modules/.cache
# 重新启动
pi
```

### 问题 2: 配置没有保存

**可能原因：**
- `flushConfig` 没有被调用
- 权限问题

**检查方法：**
```bash
# 检查配置文件权限
ls -l ~/.pi/ai-gateway/provider-ai.json

# 检查是否有备份
ls -l ~/.pi/ai-gateway/backups/

# 手动测试写入
node -e "require('fs').writeFileSync('~/.pi/ai-gateway/test.txt', 'test')"
```

### 问题 3: 性能没有提升

**可能原因：**
- performance.ts 加载失败
- 降级到直接写入模式

**检查方法：**
```bash
# 添加调试日志
grep "getDebouncedWriter" ~/.pi/agent/extensions/ai-gateway/config.ts

# 检查 performance.ts 语法
node --check ~/.pi/agent/extensions/ai-gateway/performance.ts
```

---

## 联系支持

如果遇到问题：

1. 收集错误日志
2. 记录重现步骤
3. 检查系统环境（OS、Node 版本）
4. 提供配置文件示例（删除敏感信息）

---

**文档版本：** v3.1.1  
**最后更新：** 2026-09-05
