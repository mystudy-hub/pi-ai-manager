const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/** Walk up from `start` looking for the pi-coding-agent package manifest. */
function findPackageDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === PI_PACKAGE_NAME) return dir;
    } catch { /* no manifest here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Locate the installed pi package so we can borrow its `jiti` and `pi-tui`.
 * Hardcoding one developer's global npm path made this suite unrunnable
 * everywhere else, so resolve it the same way a user's shell would.
 */
function resolvePiPackageDir() {
  const candidates = [];
  if (process.env.PI_CODING_AGENT_PACKAGE_DIR) candidates.push(process.env.PI_CODING_AGENT_PACKAGE_DIR);

  // The `pi` launcher on PATH: realpath it, then walk up to the package root.
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const bin = path.join(entry, process.platform === 'win32' ? 'pi.cmd' : 'pi');
    if (!fs.existsSync(bin)) continue;
    let resolved = bin;
    try { resolved = fs.realpathSync(bin); } catch { /* use the launcher itself */ }
    candidates.push(path.dirname(resolved));
  }

  for (const candidate of candidates) {
    const found = findPackageDir(candidate);
    if (found) return found;
  }
  throw new Error(
    `Cannot locate the ${PI_PACKAGE_NAME} install. Run this test where \`pi\` is on PATH, ` +
    'or set PI_CODING_AGENT_PACKAGE_DIR to its package directory.',
  );
}

const packageDir = resolvePiPackageDir();
const packageRequire = createRequire(path.join(packageDir, 'package.json'));
const { createJiti } = packageRequire('jiti');
const extensionDir = fs.existsSync(path.resolve(__dirname, '../src/tui.ts'))
  ? path.resolve(__dirname, '../src')
  : path.resolve(__dirname, '..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-manager-reg-'));
const settingsDir = path.join(runDir, 'extension-settings');
fs.mkdirSync(settingsDir);
process.env.PI_EXTENSION_SETTINGS_DIR = settingsDir;
process.env.PI_CODING_AGENT_DIR = runDir;

const results = [];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function provider(label = 'alpha') {
  return {
    baseUrl: `https://${label}.invalid`,
    apiKey: `synthetic-review-key-${label}`,
    defaultApi: 'openai-completions',
    models: { 'gpt-5.4': { api: 'openai-completions', contextWindow: 4096, reasoning: false } },
    enabledModels: ['gpt-5.4'],
  };
}

function config(twoProviders = false) {
  return {
    version: 1,
    providers: { alpha: provider(), ...(twoProviders ? { beta: provider('beta') } : {}) },
    settings: { testRequestDelayMs: 0, testConcurrency: 1, testQuestions: ['A', 'B', 'C'] },
  };
}

function validResponse() {
  return { content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 1, output: 1 } };
}

async function main() {
  const tuiPackage = await import(pathToFileURL(packageRequire.resolve('@earendil-works/pi-tui')).href);
  const jiti = createJiti(__filename, {
    fsCache: false,
    moduleCache: true,
    tryNative: false,
    virtualModules: {
      '@earendil-works/pi-coding-agent': { getAgentDir: () => runDir },
      '@earendil-works/pi-tui': tuiPackage,
      '@earendil-works/pi-ai/compat': { getProviders: () => ['anthropic', 'openai'] },
    },
  });
  const { RelayManagerTUI } = jiti(path.join(extensionDir, 'tui.ts'));
  const cfg = jiti(path.join(extensionDir, 'config.ts'));
  const network = jiti(path.join(extensionDir, 'network.ts'));
  const recoveryModule = jiti(path.join(extensionDir, 'config-v2.ts'));
  const realFetch = global.fetch;
  const diskConfig = () => JSON.parse(fs.readFileSync(cfg.configPath(), 'utf8'));
  const theme = { fg: (_color, text) => text, bold: text => text };

  function manager(inputConfig = config(), complete = async () => validResponse()) {
    const events = [];
    const ctx = {
      mode: 'tui',
      ui: {
        notify: (message, level) => events.push({ event: 'notify', message, level }),
        setStatus: () => {},
      },
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: true }),
        getApiKeyForProvider: async () => undefined,
        find: (name, id) => ({ id, provider: name }),
        complete,
      },
    };
    const pi = {
      registerProvider: (name, entry) => events.push({ event: 'register', name, baseUrl: entry.baseUrl }),
      unregisterProvider: name => events.push({ event: 'unregister', name }),
    };
    return { tui: new RelayManagerTUI(ctx, pi, inputConfig), config: inputConfig, events };
  }

  async function testCase(name, fn) {
    try {
      cfg.flushConfig();
      await fn();
      results.push({ name, pass: true });
      console.log(`✅ PASS: ${name}`);
    } catch (error) {
      results.push({ name, pass: false, error: error.stack });
      console.error(`❌ FAIL: ${name}\n`, error);
      process.exitCode = 1;
    } finally {
      global.fetch = realFetch;
      cfg.flushConfig();
    }
  }

  // 1. [P1 #3] 推理开关正常执行，且可通过 u 正常撤销
  await testCase('1. Reasoning toggle works without error and supports undo', async () => {
    const m = manager();
    await m.tui.handleInput('g');
    assert.equal(m.config.providers.alpha.models['gpt-5.4'].reasoning, true);
    await m.tui.handleInput('u');
    assert.equal(m.config.providers.alpha.models['gpt-5.4'].reasoning, false);
  });

  // 2. [P1 #4] 配置规范化保留全部 4 个推理与兼容字段
  await testCase('2. Config normalization preserves thinking and compat fields', async () => {
    const input = config();
    const fields = {
      thinkingLevelMap: { high: 'custom' },
      thinkingMode: 'enabled',
      thinkingEffort: 'high',
      compat: { supportsStore: false },
    };
    Object.assign(input.providers.alpha.models['gpt-5.4'], fields);
    const meta = cfg.normalizeConfig(input).providers.alpha.models['gpt-5.4'];
    for (const [k, v] of Object.entries(fields)) {
      assert.deepEqual(meta[k], v, `Field ${k} should be preserved`);
    }
  });

  // 3. [P2 #8] c 键正确触发 compareModel 而非被 probeContextWindow 遮蔽
  await testCase('3. Compare shortcut c invokes compareModel', async () => {
    const m = manager();
    const calls = [];
    m.tui.probeContextWindow = async () => calls.push('probeContextWindow');
    m.tui.compareModel = async () => calls.push('compareModel');
    await m.tui.handleInput('c');
    assert.deepEqual(calls, ['compareModel']);
  });

  // 4. [P2 #10] 新增表单按 Enter 正确切换字段
  await testCase('4. Enter advances add-provider form text fields', async () => {
    const m = manager();
    await m.tui.handleInput('n');
    await m.tui.handleInput('new-provider');
    await m.tui.handleInput('\r');
    assert.equal(m.tui.form.fieldIndex, 1);
  });

  // 5. [P2 #10] Space 操作支持 undo 撤销
  await testCase('5. Space toggle is recorded for undo', async () => {
    const m = manager();
    await m.tui.handleInput(' ');
    assert.deepEqual(m.config.providers.alpha.enabledModels, []);
    await m.tui.handleInput('u');
    assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4']);
  });

  // 6. [P2 #10] 极窄终端（24列）安全渲染不抛 RangeError
  await testCase('6. Narrow terminal rendering (24 cols) does not throw RangeError', async () => {
    const m = manager();
    const rendered = m.tui.render(24, 30, theme);
    assert.ok(Array.isArray(rendered) && rendered.length > 0);
  });

  // 7. [P2 #6] 取消不保存时，协议等模型修改被正确还原
  await testCase('7. Cancel restores model API protocol edits without persisting them', async () => {
    const m = manager();
    await m.tui.handleInput('p');
    await m.tui.handleInput(' ');
    await m.tui.handleInput('\x1b');
    cfg.flushConfig();
    const saved = diskConfig().providers.alpha;
    assert.deepEqual(saved.enabledModels, ['gpt-5.4']);
    assert.equal(saved.models['gpt-5.4'].api, 'openai-completions');
  });

  // 8. [P2 #7] Enter 保存同步落盘，退出后立即读取为最新状态
  await testCase('8. Save synchronously persists state before return', async () => {
    const initial = config();
    cfg.writeConfig(initial);
    cfg.flushConfig();
    const m = manager(config());
    await m.tui.handleInput(' ');
    const keepOpen = await m.tui.handleInput('\r');
    assert.equal(keepOpen, false);
    assert.equal(m.tui.saved, true);
    assert.deepEqual(diskConfig().providers.alpha.enabledModels, []);
  });

  // 9. [P2 #5] 主读取路径在配置损坏时自动从备份恢复
  await testCase('9. Active read path automatically recovers from valid backup', async () => {
    cfg.writeConfig(config());
    cfg.flushConfig();
    recoveryModule.getConfigRecoveryInstance().backup(cfg.configPath());
    fs.writeFileSync(cfg.configPath(), '{malformed');
    const read = cfg.readConfig();
    assert.ok(read.providers && read.providers.alpha);
    assert.deepEqual(read.providers.alpha.enabledModels, ['gpt-5.4']);
  });

  // 10. [P1 #1] 异步操作切换网关不会以切换后的名称误注册原网关
  await testCase('10. Switching gateways during probe retains target gateway identity', async () => {
    const completion = deferred();
    const started = deferred();
    const m = manager(config(true), async () => { started.resolve(); return completion.promise; });
    const probing = m.tui.compareModel();
    await started.promise;
    await m.tui.handleInput('\x1b[D');
    await m.tui.handleInput('\x1b[B');
    assert.equal(m.tui.state.selectedGateway, 'beta');
    completion.resolve(validResponse());
    await probing;
    const registrations = m.events.filter(item => item.event === 'register');
    const lastAlpha = registrations.filter(item => item.baseUrl === 'https://alpha.invalid').at(-1);
    assert.equal(lastAlpha.name, 'alpha', 'Alpha baseUrl must not be registered under beta name');
  });

  // 11. [P1 #2] Esc 中止正在进行的测试，且不覆盖后续会话保存
  await testCase('11. Esc cancels test tasks and protects newer session state', async () => {
    const completion = deferred();
    const started = deferred();
    let calls = 0;
    const first = manager(config(), async () => {
      calls++;
      if (calls === 1) { started.resolve(); return completion.promise; }
      return validResponse();
    });
    const testing = first.tui.handleInput('t');
    await started.promise;
    assert.equal(await first.tui.handleInput('\x1b'), false);

    const second = manager(config());
    await second.tui.handleInput(' ');
    await second.tui.handleInput('\r');
    assert.deepEqual(diskConfig().providers.alpha.enabledModels, []);

    completion.resolve(validResponse());
    await testing;
    cfg.flushConfig();
    assert.equal(calls, 1, 'Subsequent test prompts must be cancelled');
    assert.deepEqual(diskConfig().providers.alpha.enabledModels, [], 'Disk state must remain from second session');
  });

  // 12. [P2 #9] 网络超时覆盖响应体读取，且 busy 状态下按 Esc 不被吞掉
  await testCase('12. Network timeout covers response body and busy Esc is not swallowed', async () => {
    let signal;
    global.fetch = async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            if (!signal.aborted) {
              controller.enqueue(new TextEncoder().encode('{"data":[]}'));
              controller.close();
            }
          }, 100);
        },
      }), { status: 200 });
    };

    let timedOut = false;
    try {
      const response = await network.fetchWithTimeout('https://review.invalid', {}, 20);
      await response.json();
    } catch (err) {
      timedOut = true;
    }
    assert.ok(timedOut, 'Response reading must time out');
    assert.ok(signal.aborted, 'Abort signal must be triggered on timeout');

    // Test that busy state does not swallow Esc
    const m = manager();
    m.tui.busy = true;
    m.tui.state.mode = 'form';
    m.tui.form = { fieldIndex: 0 };
    const handled = await m.tui.handleInput('\x1b');
    assert.equal(handled, true);
    assert.equal(m.tui.busy, false);
    assert.equal(m.tui.state.mode, 'browse');
  });

  // 13. [P0] x + pattern + Enter 禁用模型：曾因 else 分支引用 if 块内的 `matches`
  //     抛 ReferenceError，经未 await 的 handleInput 变成 unhandled rejection 而终止 pi。
  await testCase('13. Disable-by-pattern (x) removes matches and does not throw', async () => {
    const m = manager();
    await m.tui.handleInput('x');
    assert.equal(m.tui.state.mode, 'pattern');
    await m.tui.handleInput('gpt-5.4');
    await m.tui.handleInput('\r');

    assert.equal(m.tui.state.mode, 'browse', 'pattern form must close after submit');
    assert.deepEqual(m.config.providers.alpha.enabledModels, []);
    const disabled = m.events.filter(e => e.event === 'notify' && /Disabled/.test(e.message));
    assert.deepEqual(disabled.map(e => e.message), ['Disabled 1 model(s) matching "gpt-5.4"']);

    await m.tui.handleInput('u');
    assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4'], 'undo must restore the disabled model');
  });

  // 14. [P0 对称路径] e + pattern + Enter 启用模型，且不误报禁用计数
  await testCase('14. Enable-by-pattern (e) adds matches', async () => {
    const m = manager();
    await m.tui.handleInput(' ');
    assert.deepEqual(m.config.providers.alpha.enabledModels, []);

    await m.tui.handleInput('e');
    await m.tui.handleInput('gpt-*');
    await m.tui.handleInput('\r');

    assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4']);
    const enabled = m.events.filter(e => e.event === 'notify' && /Enabled/.test(e.message));
    assert.deepEqual(enabled.map(e => e.message), ['Enabled 1 model(s) matching "gpt-*"']);
  });

  // 15. [P1] 同时写两个文件的路径必须同步落盘 provider-ai.json：若仍用 debounce
  //     的 writeConfig，submitForm 返回时磁盘上还没有新 provider，两文件会不一致。
  await testCase('15. Adding a provider persists provider-ai.json before syncing scoped models', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-5.4', supported_endpoint_types: ['openai'] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const m = manager();
    // Seed settings.json so the "foreign patterns are preserved" half of
    // computeScopedPatterns is covered without leaning on another test's leftovers.
    fs.writeFileSync(path.join(runDir, 'settings.json'), JSON.stringify({ enabledModels: ['alpha/gpt-5.4'] }));

    await m.tui.handleInput('n');
    await m.tui.handleInput('beta');
    await m.tui.handleInput('\r');
    await m.tui.handleInput('https://beta.invalid');
    await m.tui.handleInput('\r');
    await m.tui.handleInput('synthetic-review-key-beta');
    await m.tui.handleInput('\r');
    assert.equal(m.tui.form.fieldIndex, 3, 'form should have reached the API field');
    await m.tui.submitForm();

    // No flushConfig(): the file must already be durable on return.
    const saved = diskConfig().providers;
    assert.ok(saved.beta, 'new provider must be on disk without waiting for the debounce timer');
    assert.equal(saved.beta.baseUrl, 'https://beta.invalid');
    assert.deepEqual(saved.beta.enabledModels, ['gpt-5.4']);

    const scoped = JSON.parse(fs.readFileSync(path.join(runDir, 'settings.json'), 'utf8')).enabledModels;
    assert.ok(scoped.includes('beta/gpt-5.4'), 'scoped models must include the new provider');
    assert.ok(scoped.includes('alpha/gpt-5.4'), 'scoped models must keep the existing provider');
  });

  console.log("\n============================================================");
  const passedCount = results.filter(r => r.pass).length;
  console.log(`Summary: ${passedCount}/${results.length} tests passed.`);
  if (passedCount === results.length) {
    console.log(`🎉 All ${results.length} review regression tests passed flawlessly!`);
  } else {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
