const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test, before, beforeEach, after } = require('node:test');
const { createHarness, fixture, deferred, validResponse, discovery } = require('./harness.cjs');

let h;
before(async () => { h = await createHarness(); });
beforeEach(() => h.reset());
after(() => h?.cleanup());
const check = (name, fn) => test(name, { timeout: 5000 }, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));

check('Space and glob changes are drafts and support undo', async () => {
  const m = h.manager();
  const original = h.disk();
  await m.tui.handleInput(' ');
  assert.deepEqual(m.config.providers.alpha.enabledModels, []);
  assert.deepEqual(h.disk(), original);
  await m.tui.handleInput('u');
  assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4']);
  await m.tui.handleInput('x');
  await m.tui.handleInput('gpt-*');
  await m.tui.handleInput('\r');
  assert.deepEqual(m.config.providers.alpha.enabledModels, []);
  await m.tui.handleInput('u');
  assert.deepEqual(m.config.providers.alpha.enabledModels, ['gpt-5.4']);
});

check('Undo reasoning after rediscovery preserves newly discovered metadata', async () => {
  const m = h.manager();
  await m.tui.handleInput('g');
  global.fetch = async () => discovery([{ id: 'gpt-5.4', max_tokens: 2000, input: ['text', 'image'] }]);
  await m.tui.handleInput('r');
  await m.tui.handleInput('u');
  const meta = m.config.providers.alpha.models['gpt-5.4'];
  assert.equal(meta.reasoning, false);
  assert.equal(meta.maxTokens, 2000);
  assert.deepEqual(meta.input, ['text', 'image']);
  assert.ok(meta.lastDiscovered);
});

check('Protocol auto and undo use the latest discovered endpoint', async () => {
	const input = fixture();
	input.providers.alpha.defaultApi = 'openai-responses';
	h.reset(input);
  const m = h.manager();
  await m.tui.handleInput('p');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].api, 'anthropic-messages');
  global.fetch = async () => discovery([{ id: 'gpt-5.4', supported_endpoint_types: ['openai'] }]);
  await m.tui.handleInput('r');
  const meta = m.config.providers.alpha.models['gpt-5.4'];
  assert.equal(meta.discoveredApi, 'openai-responses');
  assert.equal(meta.api, 'anthropic-messages');
  await m.tui.handleInput('u');
  assert.equal(meta.api, 'openai-responses');
  for (let i = 0; i < 4; i++) await m.tui.handleInput('p');
  assert.equal(meta.api, 'openai-responses');
  assert.equal(Object.keys(m.config.providers.alpha.modelApiOverrides).length, 0);
});

check('Context edits are bounded and can be undone', async () => {
  const m = h.manager();
  await m.tui.handleInput('C');
  await m.tui.handleInput('128k');
  await m.tui.handleInput('\r');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, 128000);
  await m.tui.handleInput('u');
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].contextWindow, 4096);
  await m.tui.handleInput('C');
  await m.tui.handleInput('999999999999');
  await m.tui.handleInput('\r');
  assert.equal(m.tui.state.mode, 'context');
  assert.match(m.tui.contextForm.status, /Invalid/);
});

check('Esc discards edits without touching config, settings or a newer save', async () => {
  const old = h.manager();
  await old.tui.handleInput('g');
  const next = h.manager();
  await next.tui.handleInput(' ');
  assert.equal(await next.tui.handleInput('\r'), false);
  const configBytes = fs.readFileSync(h.cfg.configPath(), 'utf8');
  const savedSettings = h.settings();
  const mtime = fs.statSync(h.cfg.configPath()).mtimeMs;
  assert.equal(await old.tui.handleInput('\x1b'), false);
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), configBytes);
  assert.equal(fs.statSync(h.cfg.configPath()).mtimeMs, mtime);
  assert.deepEqual(h.settings(), savedSettings);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
});

check('Ctrl+S commits before exit and updates Pi registrations and scopes', async () => {
  const m = h.manager();
  await m.tui.handleInput(' ');
  assert.equal(await m.tui.handleInput('\x13'), false);
  assert.equal(m.tui.saved, true);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
  assert.equal(h.settings().enabledModels, undefined);
  assert.deepEqual(m.registered.get('alpha').models, []);
});

for (const key of ['t', 'A']) {
  check(`Esc cancels ${key} testing and late results cannot change a newer session`, async () => {
    h.reset(fixture(true));
    const started = deferred();
    const completion = deferred();
    let calls = 0;
    const first = h.manager(undefined, async () => { calls++; started.resolve(); return completion.promise; });
    if (key === 'A') await first.tui.handleInput('A');
    const running = first.tui.handleInput(key === 'A' ? '\r' : 't');
    await started.promise;
    assert.equal(await first.tui.handleInput('\x1b'), true);
    assert.equal(first.tui.isClosed, false);
    const next = h.manager();
    await next.tui.handleInput(' ');
    await next.tui.handleInput('\r');
    completion.resolve(validResponse());
    await running;
    assert.equal(calls, 1);
    assert.equal(h.disk().providers.alpha.models['gpt-5.4'].health, undefined);
    assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
    assert.equal(first.tui.state.testingInProgress, false);
    assert.equal(await first.tui.handleInput('\x1b'), false);
  });
}

check('Esc cancels refresh-all without overwriting a newer commit', async () => {
  h.reset(fixture(true));
  const started = deferred();
  const response = deferred();
  let requests = 0;
  global.fetch = async () => { requests++; started.resolve(); return response.promise; };
  const first = h.manager();
  const refresh = first.tui.handleInput('R');
  await started.promise;
  await first.tui.handleInput('\x1b');
  const next = h.manager();
  await next.tui.handleInput(' ');
  await next.tui.handleInput('\r');
  response.resolve(discovery([{ id: 'gpt-5.4-new' }]));
  await refresh;
  assert.equal(requests, 1);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
  assert.equal(h.disk().providers.alpha.models['gpt-5.4-new'], undefined);
});

check('Cancelling a test restores temporary credentials even when config becomes unreadable', async () => {
  const started = deferred();
  const completion = deferred();
  const m = h.manager(undefined, async () => { started.resolve(); return completion.promise; });
  m.config.providers.alpha.apiKey = 'synthetic-draft-key';
  const running = m.tui.handleInput('t');
  await started.promise;
  assert.equal(m.registered.get('alpha').apiKey, 'synthetic-draft-key');
  fs.writeFileSync(h.cfg.configPath(), '{synthetic-corrupt');
  await m.tui.handleInput('\x1b');
  assert.equal(m.registered.get('alpha').apiKey, 'synthetic-key-alpha');
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), '{synthetic-corrupt');
  completion.resolve(validResponse());
  await running;
});

check('Switching gateways while discovering preserves the target identity', async () => {
  h.reset(fixture(true));
  const started = deferred();
  const response = deferred();
  global.fetch = async () => { started.resolve(); return response.promise; };
  const m = h.manager();
  const refresh = m.tui.handleInput('r');
  await started.promise;
  await m.tui.handleInput('\x1b[D');
  await m.tui.handleInput('\x1b[B');
  assert.equal(m.tui.state.selectedGateway, 'beta');
  response.resolve(discovery([{ id: 'gpt-5.4-new' }]));
  await refresh;
  assert.ok(m.config.providers.alpha.models['gpt-5.4-new']);
  assert.equal(m.config.providers.beta.models['gpt-5.4-new'], undefined);
  assert.equal(m.tui.state.testingInProgress, false);
});

async function formToKey(m, name = 'new-gateway') {
  await m.tui.handleInput('n');
  await m.tui.handleInput(name);
  await m.tui.handleInput('\r');
  assert.equal(m.tui.form.fieldIndex, 1);
  await m.tui.handleInput('https://new.invalid');
  await m.tui.handleInput('\r');
  await m.tui.handleInput('synthetic-new-key');
}

check('Cancelled add form never applies a late response', async () => {
  const m = h.manager();
  await formToKey(m);
  const started = deferred();
  const response = deferred();
  global.fetch = async () => { started.resolve(); return response.promise; };
  // Submit from API field to exercise the add-after-cancel bug directly.
  m.tui.form.fieldIndex = 3;
  const submit = m.tui.handleInput('\r');
  await started.promise;
  await m.tui.handleInput('\x1b');
  response.resolve(discovery([{ id: 'gpt-5.4' }]));
  await submit;
  assert.equal(m.tui.state.mode, 'browse');
  assert.equal(m.config.providers['new-gateway'], undefined);
  assert.equal(h.disk().providers['new-gateway'], undefined);
  assert.equal(m.registered.has('new-gateway'), false);
});

check('Add starts with no enabled models, remains a draft, and supports undo', async () => {
  const m = h.manager();
  global.fetch = async () => discovery([{ id: 'gpt-5.4' }]);
  await formToKey(m);
  await m.tui.handleInput('\r');
  await m.tui.handleInput('\r');
  assert.ok(m.config.providers['new-gateway'].models['gpt-5.4']);
  assert.deepEqual(m.config.providers['new-gateway'].enabledModels, []);
  assert.equal(h.disk().providers['new-gateway'], undefined);
  assert.equal(m.registered.has('new-gateway'), false);
  await m.tui.handleInput('u');
  assert.equal(m.config.providers['new-gateway'], undefined);
});

check('Editing URL or key invalidates form discovery; edit and delete remain drafts', async () => {
  const m = h.manager();
  let requests = 0;
  global.fetch = async () => { requests++; return discovery([{ id: 'gpt-5.4' }]); };
  await m.tui.handleInput('E');
  await m.tui.handleInput('\x15');
  await m.tui.handleInput('https://edited.invalid');
  await m.tui.handleInput('\r');
  await m.tui.handleInput('\r');
  assert.equal(requests, 1);
  assert.ok(m.tui.form.discovered);
  await m.tui.handleInput('\x1b[A');
  await m.tui.handleInput('2');
  assert.equal(m.tui.form.discovered, undefined);
  await m.tui.handleInput('\r');
  assert.equal(requests, 2);
  await m.tui.handleInput('\r');
  assert.equal(m.config.providers.alpha.baseUrl, 'https://edited.invalid');
  assert.equal(h.disk().providers.alpha.baseUrl, 'https://alpha.invalid');
  await m.tui.handleInput('u');
  assert.equal(m.config.providers.alpha.baseUrl, 'https://alpha.invalid');
  await m.tui.handleInput('\t');
  await m.tui.handleInput('D');
  await m.tui.handleInput('\r');
  assert.equal(m.config.providers.alpha, undefined);
  assert.ok(h.disk().providers.alpha);
  assert.equal(m.registered.has('alpha'), true);
  await m.tui.handleInput('u');
  assert.ok(m.config.providers.alpha);
});

check('Duplicate or unsafe provider names fail before discovery', async () => {
  for (const name of ['alpha', '__proto__', 'openai', 'bad/name']) {
    const m = h.manager();
    let requests = 0;
    global.fetch = async () => { requests++; return discovery([]); };
    await formToKey(m, name);
    await m.tui.handleInput('\r');
    await m.tui.handleInput('\r');
    assert.equal(requests, 0, name);
    assert.equal(m.tui.form.statusKind, 'error', name);
  }
});

check('Batch confirmation describes its scope and sends no requests until Enter', async () => {
  h.reset(fixture(true));
  let calls = 0;
  const m = h.manager(undefined, async (_model, _context, options) => {
    calls++;
    assert.equal(options.maxTokens, 256);
    assert.equal(options.maxRetries, 0);
    return validResponse();
  });
  await m.tui.handleInput('A');
  assert.equal(calls, 0);
  assert.match(m.tui.render(120, 30, h.theme).join('\n'), /2 models, 2 requests, up to 512 output tokens/);
  await m.tui.handleInput('\x1b');
  assert.equal(calls, 0);
  await m.tui.handleInput('T');
  assert.equal(m.tui.pendingTest.count, 1);
  await m.tui.handleInput('\r');
  assert.equal(calls, 1);
  assert.equal(m.config.providers.alpha.models['gpt-5.4'].health.status, 'healthy');
  assert.equal(h.disk().providers.alpha.models['gpt-5.4'].health, undefined);
});

check('Compare uses recorded metrics without a paid request', async () => {
  h.reset(fixture(true));
  const m = h.manager(undefined, async () => { throw new Error('Unexpected paid request'); });
  await m.tui.handleInput('c');
  assert.equal(m.tui.state.mode, 'compare');
  const screen = m.tui.render(100, 24, h.theme).join('\n');
  assert.match(screen, /alpha/);
  assert.match(screen, /beta/);
});

check('Auto-select does not enable a recently failed model', async () => {
  const input = fixture();
  input.providers.alpha.enabledModels = [];
  input.providers.alpha.models['gpt-5.4'].health = { status: 'down', lastCheck: Date.now(), consecutiveFailures: 2 };
  h.reset(input);
  const m = h.manager();
  await m.tui.handleInput('a');
  assert.deepEqual(m.config.providers.alpha.enabledModels, []);
});

check('Tab toggles panes, help scrolls, and narrow terminals render safely', async () => {
  const m = h.manager();
  await m.tui.handleInput('\t');
  assert.equal(m.tui.state.activePane, 'gateways');
  await m.tui.handleInput('\t');
  assert.equal(m.tui.state.activePane, 'models');
  for (const width of [1, 12, 24, 80]) assert.ok(m.tui.render(width, 30, h.theme).length);
  await m.tui.handleInput('?');
  m.tui.render(80, 20, h.theme);
  await m.tui.handleInput('\x1b[6~');
  assert.ok(m.tui.helpOffset > 0);
  await m.tui.handleInput('\x1b');
  assert.equal(m.tui.state.mode, 'browse');
});

check('Custom component renders in-flight progress and catches async input errors', async () => {
  const started = deferred();
  const response = deferred();
  const m = h.manager(undefined, async () => { started.resolve(); return response.promise; });
  const run = m.tui.run();
  assert.equal(m.component.handleInput('t'), undefined);
  await started.promise;
  assert.ok(m.renderRequests > 0);
  assert.equal(m.tui.state.testingInProgress, true);
  response.resolve(validResponse());
  await tick();
  assert.equal(m.tui.state.testingInProgress, false);
  const original = m.tui.handleInput.bind(m.tui);
  m.tui.handleInput = async () => { throw new Error('synthetic handler failure'); };
  m.component.handleInput('g');
  await tick();
  assert.ok(m.events.some(event => /synthetic handler failure/.test(event.message)));
  m.tui.handleInput = original;
  m.component.handleInput('\x1b');
  assert.equal(await run, false);
});

check('Sync models from gateway detects new, retained and missing models and updates TUI summary', async () => {
  h.reset(fixture());
  const started = deferred();
  const response = deferred();
  global.fetch = async () => { started.resolve(); return response.promise; };
  const m = h.manager();
  const syncPromise = m.tui.handleInput('r');
  await started.promise;
  response.resolve(discovery([
    { id: 'gpt-5.4', max_tokens: 4096 },
    { id: 'claude-3-7-sonnet', supported_endpoint_types: ['anthropic'], reasoning: true, context_window: 200000 },
  ]));
  await syncPromise;

  assert.ok(m.config.providers.alpha.models['claude-3-7-sonnet']);
  assert.equal(m.config.providers.alpha.models['claude-3-7-sonnet'].api, 'anthropic-messages');
  assert.equal(m.config.providers.alpha.models['claude-3-7-sonnet'].reasoning, true);
  assert.equal(m.config.providers.alpha.models['claude-3-7-sonnet'].contextWindow, 200000);

  assert.ok(m.tui.syncSummary);
  assert.deepEqual(m.tui.syncSummary.addedModels, ['claude-3-7-sonnet']);
  assert.deepEqual(m.tui.syncSummary.updatedModels, ['gpt-5.4']);
  assert.equal(m.tui.syncSummary.totalRemote, 2);

  const screen = m.tui.render(100, 24, h.theme).join('\n');
  assert.match(screen, /更新模型/);
});

