const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { createHarness, fixture, deferred, validResponse, discovery } = require('./harness.cjs');

let h;
before(async () => { h = await createHarness(); });
beforeEach(() => h.reset());
after(() => h?.cleanup());
const check = (name, fn) => test(name, { timeout: 12000 }, fn);
const selected = m => m.tui.state.filteredRows[m.tui.state.selectedModelIndex]?.id;
const plain = lines => h.tuiSdk.stripTerminalSequences(lines.join('\n'));
async function keys(m, ...values) { for (const value of values) await m.tui.handleInput(value); }
function manyModels(count = 60) {
  const data = fixture(true);
  for (const entry of Object.values(data.providers)) {
    for (let index = 0; index < count; index++) entry.models['model-' + String(index).padStart(3, '0')] = { api: 'openai-completions' };
  }
  return data;
}
function assertFits(lines, width, height) {
  assert.ok(lines.length > 0 && lines.length <= height, `${width}x${height}: ${lines.length} rows`);
  for (const line of lines) assert.ok(h.tuiSdk.visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(line)}`);
}

check('All views fit small and large viewports, including CJK, emoji and long IDs', async () => {
  const data = manyModels(25);
  const longId = '中文模型👩‍💻-'.repeat(30);
  data.providers.alpha.models[longId] = { api: 'openai-responses' };
  data.providers.alpha.enabledModels = [longId];
  const views = [[], ['?'], ['i'], [' ', 'v'], ['c'], [':'], ['f'], ['n'], ['C'], ['e'], ['/', '中文😀'], ['T'], ['\t', 'D']];
  for (const actions of views) {
    const m = h.manager(structuredClone(data));
    await keys(m, ...actions);
    for (const width of [1, 8, 20, 40, 60, 68, 80, 90, 100, 120]) {
      for (const height of [1, 2, 3, 8, 12, 16, 24, 50]) {
        const lines = m.tui.render(width, height, h.theme);
        assertFits(lines, width, height);
        if (width >= 20) assert.match(plain(lines.slice(-1)), /Esc/, `missing exit hint in ${actions} at ${width}x${height}`);
        if (width >= 20 && actions.length === 0) assert.match(plain(lines.slice(-1)), /Enter.*保存.*Esc/);
      }
    }
  }
});

check('Narrow screens show the active pane and tall screens use more than 20 model rows', async () => {
  const m = h.manager(manyModels());
  const small = m.tui.render(80, 12, h.theme);
  assert.equal(small.length, 12);
  assert.match(plain(small.slice(-1)), /Enter 保存退出.*Esc 放弃退出/);
  assert.doesNotMatch(plain(small), / │ /);
  assert.match(plain(m.tui.render(100, 16, h.theme)), / │ /);
  m.tui.render(80, 50, h.theme);
  assert.ok(m.tui.visibleRows > 20);
  await keys(m, '\t');
  const gateways = plain(m.tui.render(60, 12, h.theme));
  assert.match(gateways, /beta/);
  assert.doesNotMatch(gateways, /gpt-5.4|model-000/);
  assert.match(plain(m.tui.render(40, 8, h.theme)), /: 操作/);
});

check('Long model names cannot push status and latency out of their columns', () => {
  const data = fixture();
  const id = '模型😀'.repeat(70);
  data.providers.alpha.models = { [id]: { api: 'openai-responses', health: { status: 'healthy', lastCheck: Date.now(), consecutiveFailures: 0 }, metrics: { avgResponseTime: 821, minResponseTime: 820, maxResponseTime: 822, timestamp: Date.now() } } };
  data.providers.alpha.enabledModels = [id];
  const m = h.manager(data);
  const row = plain(m.tui.render(80, 12, h.theme)).split('\n').find(line => line.includes('[x]'));
  assert.match(row, /Responses/);
  assert.match(row, /正常\s+821ms/);
  assert.ok(h.tuiSdk.visibleWidth(row) <= 80);
});

check('All model settings stay visible, following selection and effective Pi defaults', async () => {
  const data = fixture();
  const entry = data.providers.alpha;
  const unknown = 'unknown-settings-模型😀';
  entry.models[unknown] = { api: 'openai-completions' };
  const catalogProvider = h.compat.getProviders().find(name => h.compat.getModels(name).some(model => model.reasoning));
  const catalogModel = h.compat.getModels(catalogProvider).find(model => model.reasoning);
  const known = catalogProvider + '/' + catalogModel.id;
  entry.models[known] = { api: 'openai-completions' };
  const before = structuredClone(data);
  const m = h.manager(data);
  for (const width of [20, 40, 60, 80, 100, 120]) {
    for (const height of [8, 12, 24]) {
      const lines = m.tui.render(width, height, h.theme);
      assertFits(lines, width, height);
      assert.match(plain(lines), /p 协议：Completions/);
      assert.match(plain(lines), /g\/b 推理：不支持/);
      assert.match(plain(lines), /C 上下文：4,096/);
    }
  }
  const wide = plain(m.tui.render(120, 12, h.theme));
  assert.match(wide, /模型\s+协议\s+推理\s+上下文\s+状态\s+延迟/);
  assert.match(wide.split('\n').find(line => line.includes('[x]')), /不支持\s+4,096/);
  assert.match(plain(m.tui.render(40, 8, h.theme).slice(-2, -1)), /p 协议.*g\/b 推理.*C 上下文/);
  await keys(m, '/', 'unknown-settings', '\r');
  assert.equal(selected(m), unknown);
  assert.match(plain(m.tui.render(20, 8, h.theme)), /C 上下文：约32,768/);
  await keys(m, '/', '\x15', known, '\r');
  assert.equal(selected(m), known);
  const automatic = plain(m.tui.render(80, 12, h.theme));
  assert.match(automatic, /g\/b 推理：支持/);
  assert.ok(automatic.includes('C 上下文：' + catalogModel.contextWindow.toLocaleString('en-US')));
  assert.deepEqual(structuredClone(m.config), before, 'displaying defaults must not write them into the draft');
});

check('Protocol selection in browse and details changes only the selected model and saves its exact pin', async () => {
  const data = fixture(true);
  // A dot in the selected ID must not also match the sibling's X.
  const sibling = 'gpt-5X4';
  data.providers.alpha.models[sibling] = { api: 'openai-completions' };
  data.providers.alpha.enabledModels.push(sibling);
  h.reset(data);
  const original = h.disk();
  const m = h.manager();
  const baseline = structuredClone(m.config);
  const api = id => h.providers.buildModelConfigs(m.config.providers.alpha, [id])[0].api;
  for (const expected of ['anthropic-messages', 'openai-responses', 'openai-completions', 'openai-completions']) {
    await keys(m, 'p');
    assert.equal(selected(m), 'gpt-5.4');
    assert.equal(api('gpt-5.4'), expected);
    assert.equal(api(sibling), 'openai-completions');
    assert.deepEqual(structuredClone(m.config.providers.beta), baseline.providers.beta);
    assert.equal(m.config.providers.alpha.defaultApi, 'openai-completions');
    assert.deepEqual(h.disk(), original);
  }
  assert.equal(Object.keys(m.config.providers.alpha.modelApiOverrides).length, 0);
  assert.equal(m.tui.draftSummary().total, 0);
  assert.match(plain(m.tui.render(80, 12, h.theme)), /p 协议：Completions（自动）/);
  await keys(m, 'i', '\x1b[112;1u');
  assert.equal(m.tui.state.mode, 'details');
  assert.match(plain(m.tui.render(80, 20, h.theme)), /协议：anthropic-messages（手工规则；p 切换）/);
  assert.equal(api(sibling), 'openai-completions');
  await keys(m, '\x1b', 'u');
  assert.equal(m.tui.draftSummary().total, 0);
  await keys(m, 'p');
  assert.equal(await m.tui.handleInput('\r'), false);
  const saved = h.disk();
  assert.equal(saved.providers.alpha.modelApiOverrides['^gpt-5\\.4$'], 'anthropic-messages');
  assert.deepEqual(saved.providers.alpha.models[sibling], original.providers.alpha.models[sibling]);
  assert.deepEqual(saved.providers.beta, JSON.parse(JSON.stringify(baseline.providers.beta)));
  assert.equal(saved.providers.alpha.defaultApi, original.providers.alpha.defaultApi);
  const registered = m.registered.get('alpha').models;
  assert.equal(registered.find(model => model.id === 'gpt-5.4').api, 'anthropic-messages');
  assert.equal(registered.find(model => model.id === sibling).api, 'openai-completions');
  const cancelled = h.manager();
  await keys(cancelled, 'p');
  assert.equal(await cancelled.tui.handleInput('\x1b'), false);
  assert.deepEqual(h.disk(), saved);
});

check('Displayed protocol follows rule precedence and undo restores the original order', async () => {
  const data = fixture();
  data.providers.alpha.models['gpt-5.4'].api = 'openai-responses';
  data.providers.alpha.modelApiOverrides = { '^gpt-': 'openai-completions', '^gpt-5\\.4$': 'anthropic-messages' };
  h.reset(data);
  const m = h.manager();
  const original = structuredClone(m.config);
  const api = () => h.providers.buildModelConfigs(m.config.providers.alpha, ['gpt-5.4'])[0].api;
  assert.equal(api(), 'openai-completions');
  const browse = plain(m.tui.render(80, 12, h.theme));
  assert.match(browse, /p 协议：Completions（规则）/);
  assert.match(browse.split('\n').find(line => line.includes('[x]')), /Completions/);
  await keys(m, 'i');
  assert.match(plain(m.tui.render(80, 20, h.theme)), /协议：openai-completions/);
  await keys(m, 'p');
  assert.equal(api(), 'openai-responses');
  await keys(m, '\x1b', 'u');
  assert.equal(api(), 'openai-completions');
  assert.deepEqual(Object.entries(m.config.providers.alpha.modelApiOverrides), Object.entries(original.providers.alpha.modelApiOverrides));
  assert.deepEqual(structuredClone(m.config), original);
  assert.equal(m.tui.draftSummary().total, 0);
  await keys(m, 'p', 'p', 'p');
  assert.equal(Object.hasOwn(m.config.providers.alpha.modelApiOverrides, '^gpt-5\\.4$'), false);
  assert.equal(api(), 'openai-completions', 'auto still respects the remaining gateway rule');
  assert.match(plain(m.tui.render(80, 12, h.theme)), /p 协议：Completions（规则）/);
});

check('Model details edit settings as an undoable draft and return after applying or cancelling', async () => {
  const m = h.manager();
  const original = h.disk();
  await keys(m, 'i', 'g');
  assert.equal(m.tui.state.mode, 'details');
  assert.match(plain(m.tui.render(80, 20, h.theme)), /推理声明：支持/);
  // Shift+C from an enhanced terminal opens the same editor as literal uppercase C.
  await keys(m, '\x1b[99;2u');
  assert.equal(m.tui.state.mode, 'context');
  const form = plain(m.tui.render(80, 12, h.theme));
  assert.match(form, /当前长度：4,096 tokens/);
  assert.match(form, /空值清除手工设置/);
  await keys(m, '128k', '\r');
  assert.equal(m.tui.state.mode, 'details');
  assert.match(plain(m.tui.render(80, 20, h.theme)), /上下文：128,000 tokens/);
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, 128000);
  await keys(m, 'C', '256k', '\x1b');
  assert.equal(m.tui.state.mode, 'details');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, 128000);
  await keys(m, 'C', '\r');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, undefined);
  const fallback = h.providers.modelLimits(m.config.providers.alpha, 'gpt-5.4').contextWindow;
  assert.ok(plain(m.tui.render(80, 20, h.theme)).includes(fallback.toLocaleString('en-US') + ' tokens'));
  assert.deepEqual(h.disk(), original);
  await keys(m, '\x1b', 'u');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, 128000);
  await keys(m, 'u', 'u');
  assert.equal(m.tui.draftSummary().total, 0);
  await keys(m, 'i', 'b', 'C', '128k', '\r', '\x1b');
  assert.equal(await m.tui.handleInput('\r'), false);
  const saved = h.disk().providers.alpha.models['gpt-5.4'];
  assert.equal(saved.reasoning, true);
  assert.equal(saved.contextWindow, 128000);
  const registered = m.registered.get('alpha').models.find(model => model.id === 'gpt-5.4');
  assert.equal(registered.reasoning, true);
  assert.equal(registered.contextWindow, 128000);
});

check('Sorting, toggling, searching and discovery preserve the selected model ID', async () => {
  const data = fixture();
  data.providers.alpha.models['gpt-5.4-mini'] = { api: 'openai-completions' };
  data.providers.alpha.models['custom-8b'] = { api: 'openai-completions' };
  const m = h.manager(data);
  await keys(m, '\x1b[F');
  const id = selected(m);
  for (let index = 0; index < 4; index++) { await keys(m, 's'); assert.equal(selected(m), id); }
  await keys(m, ' ');
  assert.equal(selected(m), id);
  await keys(m, 'u', '/', 'gpt', '\r');
  assert.equal(selected(m), id);
  await keys(m, '/', '\x15', 'no-matches');
  assert.equal(m.tui.state.filteredRows.length, 0);
  await keys(m, '\x1b');
  assert.equal(m.tui.filterInput.value, 'gpt');
  assert.equal(selected(m), id);
  global.fetch = async () => discovery([{ id }, { id: 'gpt-0-added' }]);
  await keys(m, 'r');
  assert.equal(selected(m), id);
});

check('Each gateway remembers selection and scroll position', async () => {
  const m = h.manager(manyModels());
  m.tui.render(80, 12, h.theme);
  await keys(m, '\x1b[F');
  m.tui.render(80, 12, h.theme);
  const alpha = { id: selected(m), scroll: m.tui.state.scrollOffset };
  await keys(m, '\t', '\x1b[B', '\t', '\x1b[6~');
  m.tui.render(80, 12, h.theme);
  const beta = { id: selected(m), scroll: m.tui.state.scrollOffset };
  assert.notEqual(beta.id, alpha.id);
  await keys(m, '\t', '\x1b[A', '\t');
  m.tui.render(80, 12, h.theme);
  assert.equal(selected(m), alpha.id);
  assert.equal(m.tui.state.scrollOffset, alpha.scroll);
  await keys(m, '\t', '\x1b[B', '\t');
  m.tui.render(80, 12, h.theme);
  assert.equal(selected(m), beta.id);
  assert.equal(m.tui.state.scrollOffset, beta.scroll);
});

check('All models are shown by default; status and quality filters have a reset menu', async () => {
  const data = fixture();
  data.providers.alpha.models['custom-8b'] = { api: 'openai-completions' };
  data.providers.alpha.enabledModels.push('custom-8b');
  const m = h.manager(data);
  assert.equal(m.tui.state.qualityFilter, 'all');
  assert.equal(m.tui.state.sortMode, 'enabled');
  assert.equal(m.tui.state.filteredRows.filter(row => row.enabled).length, 2);
  await keys(m, 'f', '已启用', '\r');
  assert.equal(m.tui.state.filterMode, 'enabled');
  assert.equal(m.tui.state.filteredRows.length, 2);
  await keys(m, 'q');
  assert.equal(m.tui.state.filteredRows.length, 1);
  assert.match(plain(m.tui.render(80, 12, h.theme)), /显示 1\/2/);
  await keys(m, '/', 'gpt', '\r', 'f', '重置', '\r');
  assert.equal(m.tui.state.filterMode, 'all');
  assert.equal(m.tui.state.qualityFilter, 'all');
  assert.equal(m.tui.filterInput.value, '');
  assert.equal(m.tui.state.filteredRows.length, 2);
});

check('Expired health is unknown in sorting, filtering and refreshed rendering', async () => {
  const now = Date.now();
  const ttl = h.load('types').HEALTH_TTL_MS;
  const data = fixture();
  data.providers.alpha.models = {
    'a-stale': { api: 'openai-completions', health: { status: 'healthy', lastCheck: now - ttl - 100, consecutiveFailures: 0 } },
    'z-fresh': { api: 'openai-completions', health: { status: 'healthy', lastCheck: now, consecutiveFailures: 0 } },
  };
  data.providers.alpha.enabledModels = [];
  const m = h.manager(data);
  await keys(m, 's', 's');
  assert.deepEqual(m.tui.state.filteredRows.map(row => row.id), ['z-fresh', 'a-stale']);
  await keys(m, 'f', '未测', '\r');
  assert.deepEqual(m.tui.state.filteredRows.map(row => row.id), ['a-stale']);
  await keys(m, 'f', '健康', '\r');
  assert.equal(m.tui.state.filteredRows.length, 1);
  const originalNow = Date.now;
  try {
    Date.now = () => now + ttl + 200;
    m.tui.render(80, 12, h.theme);
    assert.equal(m.tui.state.filteredRows.length, 0);
  } finally { Date.now = originalNow; }
});

check('Dirty summary is a real difference, not undo history length', async () => {
  const m = h.manager();
  assert.equal(m.tui.draftSummary().total, 0);
  await keys(m, ' ');
  assert.equal(m.tui.draftSummary().config, 1);
  assert.match(plain(m.tui.render(80, 12, h.theme)[0].split('\n')), /未保存：1 项/);
  await keys(m, ' ');
  assert.equal(m.tui.draftSummary().total, 0);
  assert.equal(m.tui.operationHistory.canUndo(), true);
  await keys(m, 'u', 'u');
  assert.equal(m.tui.draftSummary().total, 0);
  await keys(m, 'p', 'u', 'C', '128k', '\r');
  assert.equal(m.tui.draftSummary().config, 1);
  await keys(m, 'u');
  assert.equal(m.tui.draftSummary().total, 0);
});

check('Change list hides credentials and treats rule order as a real routing change', () => {
  const { summarizeDraft } = h.load('tui-draft');
  const before = fixture();
  const after = structuredClone(before);
  after.providers.alpha.modelApiOverrides = {};
  assert.equal(summarizeDraft(before, after).total, 0);
  after.providers.alpha.apiKey = 'synthetic-replacement-secret';
  const changes = JSON.stringify(summarizeDraft(before, after));
  assert.match(changes, /凭据已修改/);
  assert.doesNotMatch(changes, /synthetic-key-alpha|synthetic-replacement-secret/);
  before.providers.alpha.modelApiOverrides = { '^gpt-': 'openai-responses', '^gpt-5': 'openai-completions' };
  after.providers.alpha = structuredClone(before.providers.alpha);
  after.providers.alpha.modelApiOverrides = { '^gpt-5': 'openai-completions', '^gpt-': 'openai-responses' };
  assert.equal(summarizeDraft(before, after).config, 1);
});

check('Change panel distinguishes configuration, test and discovery records without writing them', async () => {
  const m = h.manager();
  const original = h.disk();
  await keys(m, ' ', 't');
  assert.equal(m.tui.draftSummary().config, 1);
  assert.equal(m.tui.draftSummary().test, 1);
  global.fetch = async () => discovery([{ id: 'gpt-5.4' }]);
  await keys(m, 'r', 'v');
  const text = plain(m.tui.render(120, 30, h.theme));
  for (const label of ['配置', '测试', '发现']) assert.ok(text.includes('[' + label + ']'));
  assert.deepEqual(h.disk(), original);
});

check('Details show full IDs, capabilities, unknown cost and redacted failures across gateway switches', async () => {
  const data = fixture(true);
  const id = 'unknown-模型😀-'.repeat(20);
  data.providers.alpha.models = { [id]: { api: 'openai-responses' } };
  data.providers.alpha.enabledModels = [id];
  const runtimeKey = 'synthetic-runtime-' + 'private-credential-'.repeat(30);
  const m = h.manager(data, async () => { throw new Error('HTTP 401 ' + runtimeKey + ' Bearer other-secret \x1b]52;c;bad\x07'); });
  m.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: 'runtime' });
  m.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: runtimeKey } });
  await keys(m, 't', 'i');
  const text = plain(m.tui.render(80, 50, h.theme));
  assert.ok(text.replace(/\s/g, '').includes(id));
  assert.match(text, /openai-responses/);
  assert.match(text, /32,768 tokens（估算）/);
  assert.match(text, /价格：未知/);
  assert.match(text, /HTTP 401/);
  assert.doesNotMatch(text, /private-credential|other-secret|synthetic-key-alpha|synthetic-runtime/);
  await keys(m, '\x1b', '\t', '\x1b[B', '\t', '\t', '\x1b[A', '\t', 'i');
  assert.match(plain(m.tui.render(80, 50, h.theme)), /HTTP 401/);
  assert.equal(m.tui.state.filteredRows[0].testResult.passed, 0);
});

check('Gateway details describe credential configuration without claiming connectivity', async () => {
  const m = h.manager();
  const original = structuredClone(m.config);
  await keys(m, '\t', 'i');
  const text = plain(m.tui.render(80, 20, h.theme));
  assert.match(text, /凭据：已配置/);
  assert.match(text, /不代表已验证连通性/);
  assert.doesNotMatch(text, /synthetic-key-alpha/);
  await keys(m, 'p', 'g', 'C');
  assert.equal(m.tui.state.mode, 'details');
  assert.equal(m.tui.contextForm, null);
  assert.deepEqual(structuredClone(m.config), original);
});

check('Browsing during testing keeps the original target, and Ctrl+C in details only stops the task', async () => {
  h.reset(fixture(true));
  const started = deferred();
  const completion = deferred();
  const calls = [];
  const m = h.manager(undefined, async model => { calls.push(model.provider); started.resolve(); return completion.promise; });
  await keys(m, 'g');
  const running = m.tui.handleInput('t');
  await started.promise;
  await keys(m, 's', '/', 'gpt', '\r', '\t', '\x1b[B', '\t');
  assert.equal(m.tui.state.selectedGateway, 'beta');
  assert.equal(m.tui.state.testingInProgress, true);
  const before = structuredClone(m.config.providers.beta);
  await keys(m, ' ', 'E', 'i');
  assert.deepEqual(structuredClone(m.config.providers.beta), before);
  assert.equal(m.tui.form, null);
  assert.equal(m.tui.state.mode, 'details');
  await keys(m, 'p', '\x1b[112;1u', 'g', 'C', '\x1b[99;2u');
  assert.equal(m.tui.state.mode, 'details');
  assert.equal(m.tui.contextForm, null);
  assert.deepEqual(structuredClone(m.config.providers.beta), before);
  assert.ok(m.events.some(event => event.type === 'notify' && /任务进行中/.test(event.message)));
  await keys(m, '\x03');
  assert.equal(m.tui.state.testingInProgress, false);
  assert.equal(m.tui.state.mode, 'details');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].reasoning, true);
  completion.resolve(validResponse());
  await running;
  assert.deepEqual(calls, ['alpha']);
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].health, undefined);
  assert.equal(h.disk().providers.alpha.models['gpt-5.4'].reasoning, false);
  await keys(m, '\x1b');
  assert.equal(m.tui.isClosed, false);
  assert.equal(await m.tui.handleInput('\x1b'), false);
});

for (const batch of ['T', 'A']) {
  check(`Stopping ${batch} preserves completed results and the draft can then be saved`, async () => {
    const data = fixture(true);
    data.providers.alpha.models['gpt-5.4-mini'] = { api: 'openai-completions' };
    data.providers.alpha.enabledModels.push('gpt-5.4-mini');
    h.reset(data);
    const secondStarted = deferred();
    const completion = deferred();
    let calls = 0;
    const m = h.manager(undefined, async () => {
      calls++;
      if (calls === 1) return validResponse();
      secondStarted.resolve();
      return completion.promise;
    });
    await keys(m, 'g', batch);
    const running = m.tui.handleInput('\r');
    await secondStarted.promise;
    assert.equal(m.tui.state.testProgress.current, 1);
    assert.equal(await m.tui.handleInput('\x1b'), true);
    assert.equal(m.tui.isClosed, false);
    assert.equal(m.config.providers.alpha.models['gpt-5.4'].health.status, 'healthy');
    assert.equal(m.config.providers.alpha.models['gpt-5.4'].reasoning, true);
    assert.equal(m.config.providers.alpha.models['gpt-5.4-mini'].health, undefined);
    assert.equal(await m.tui.handleInput('\r'), false);
    const saved = h.disk();
    assert.equal(saved.providers.alpha.models['gpt-5.4'].health.status, 'healthy');
    assert.equal(saved.providers.alpha.models['gpt-5.4'].reasoning, true);
    completion.resolve(validResponse());
    await running;
    assert.equal(calls, 2);
    assert.deepEqual(h.disk(), saved);
  });
}

check('A late result from a stopped run cannot overwrite a new test in the same manager', async () => {
  const started = deferred();
  const completion = deferred();
  let calls = 0;
  const m = h.manager(undefined, async () => { if (++calls === 1) { started.resolve(); return completion.promise; } return validResponse(); });
  const old = m.tui.handleInput('t');
  await started.promise;
  await keys(m, '\x1b', 't');
  const updated = structuredClone(m.config);
  assert.equal(updated.providers.alpha.models['gpt-5.4'].health.status, 'healthy');
  completion.resolve({ content: [], stopReason: 'error', errorMessage: 'late failure' });
  await old;
  assert.deepEqual(structuredClone(m.config), updated);
  assert.equal(m.tui.state.testingInProgress, false);
});

check('Searchable action menu dispatches model actions, subpages and save without leaking Enter', async () => {
  const m = h.manager();
  await keys(m, ':', '详情', '\r');
  assert.equal(m.tui.state.mode, 'details');
  assert.equal(m.tui.saved, false);
  await keys(m, '\x1b', ':', 'toggle', '\r');
  assert.deepEqual(m.config.providers.alpha.enabledModels, []);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, ['gpt-5.4']);
  await keys(m, ':', 'context', '\r');
  assert.equal(m.tui.state.mode, 'context');
  await keys(m, '\x1b', ':', 'save');
  assert.equal(await m.tui.handleInput('\r'), false);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
});

check('The action menu blocks edits during a task and can stop it without discarding the draft', async () => {
  const started = deferred();
  const completion = deferred();
  const m = h.manager(undefined, async () => { started.resolve(); return completion.promise; });
  await keys(m, 'g');
  const running = m.tui.handleInput('t');
  await started.promise;
  await keys(m, ':', 'toggle');
  assert.equal(m.tui.menuItems()[0].enabled, false);
  await keys(m, '\r');
  assert.equal(m.tui.state.mode, 'menu');
  assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4']);
  await keys(m, '\x15', 'stop', '\r');
  assert.equal(m.tui.state.mode, 'browse');
  assert.equal(m.tui.state.testingInProgress, false);
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].reasoning, true);
  completion.resolve(validResponse());
  await running;
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].health, undefined);
});

check('Enhanced terminal keys keep shortcut case, insert text and ignore release events', async () => {
  const m = h.manager();
  await keys(m, '\x1b[115;1u');
  assert.equal(m.tui.state.sortMode, 'name');
  await keys(m, '\x1b[101;2u');
  assert.equal(m.tui.state.mode, 'form');
  assert.equal(m.tui.form.editingName, 'alpha');
  await keys(m, '\x1b[27;1:3u');
  assert.equal(m.tui.state.mode, 'form');
  const { TextInput } = h.load('tui-input');
  const input = new TextInput();
  for (const key of ['\x1b[97:65;2u', '\x1b[20013;1u', '\x1b[97;1:3u', '\x1b[115;5u']) input.handleInput(key);
  assert.equal(input.value, 'A中');
});

check('Text inputs edit at the cursor and delete whole graphemes', () => {
  const { TextInput } = h.load('tui-input');
  const input = new TextInput();
  input.value = 'a中😀z';
  for (const key of ['\x1b[H', '\x1b[C', 'X', '\x1b[3~', '\x1b[C', '\x7f', '\x1b[F', '尾']) input.handleInput(key);
  assert.equal(input.value, 'aXz尾');
  input.value = 'A👩‍💻e\u0301Z';
  for (const key of ['\x1b[D', '\x7f', '\x7f']) input.handleInput(key);
  assert.equal(input.value, 'AZ');
  input.value = 'abcd';
  for (const key of ['\x1b[H', '\x1b[C', '\x1b[C', '\x1b[200~中\n', '😀\x1b[201~']) input.handleInput(key);
  assert.equal(input.value, 'ab中 😀cd');
});

check('Long inputs scroll to the cursor, stay within columns and never reveal masked text', () => {
  const { TextInput } = h.load('tui-input');
  const input = new TextInput();
  input.value = '中'.repeat(40) + 'TAIL';
  assert.match(input.render(h.theme, 10), /TAIL▏$/);
  for (const masked of [false, true]) {
    const field = new TextInput(masked);
    field.value = '密钥👩‍💻-' + 'private'.repeat(15);
    for (const key of ['\x1b[H', '\x1b[C', '\x1b[F', '\x1b[D']) {
      field.handleInput(key);
      for (const width of [0, 1, 2, 6, 10, 20, 80]) {
        const rendered = field.render(h.theme, width);
        assert.ok(h.tuiSdk.visibleWidth(rendered) <= width);
        if (width) assert.match(rendered, /▏/);
        if (masked) assert.doesNotMatch(rendered, /密|钥|private|👩/);
      }
    }
  }
});

check('Input and paste limits preserve Unicode and discard oversized paste tails', () => {
  const { TextInput } = h.load('tui-input');
  const input = new TextInput();
  input.value = 'x'.repeat(4095) + '😀';
  assert.equal(input.value.length, 4095);
  assert.equal(input.value.isWellFormed(), true);
  input.clear();
  input.handleInput('\x1b[200~' + 'x'.repeat(17000));
  input.handleInput('discard-this-tail\x1b[20');
  input.handleInput('1~');
  assert.equal(input.value, '');
  input.handleInput('ok');
  assert.equal(input.value, 'ok');
});

check('Cursor movement retains discovery cache and short forms keep the active field visible', async () => {
  const m = h.manager();
  await keys(m, 'E');
  const cached = [{ id: 'gpt-5.4' }];
  m.tui.form.discovered = cached;
  m.tui.form.detectState = 'done';
  await keys(m, '\x1b[D', '\x1b[C');
  assert.equal(m.tui.form.discovered, cached);
  await keys(m, '\x1b[H', '\x1b[3~');
  assert.equal(m.tui.form.discovered, undefined);
  await keys(m, '\x1b[Z');
  assert.equal(m.tui.form.fieldIndex, 3);
  assert.match(plain(m.tui.render(30, 4, h.theme)), /> API:/);
  await keys(m, '\t');
  assert.equal(m.tui.form.fieldIndex, 1);
  assert.match(plain(m.tui.render(30, 4, h.theme)), /▏/);
});

check('The Pi component uses the terminal height and a bounded full-window overlay', async () => {
  const m = h.manager(manyModels());
  m.terminal.rows = 12;
  const running = m.tui.run();
  assert.equal(m.customOptions.overlay, true);
  assert.equal(m.customOptions.overlayOptions.maxHeight, '100%');
  assertFits(m.component.render(80), 80, 12);
  m.terminal.rows = 8;
  assertFits(m.component.render(40), 40, 8);
  m.component.handleInput('\x1b');
  assert.equal(await running, false);
});
