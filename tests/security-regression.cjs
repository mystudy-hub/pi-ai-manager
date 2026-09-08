const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, beforeEach, after } = require('node:test');
const { createHarness, provider, deferred, discovery, validResponse } = require('./harness.cjs');

let h;
before(async () => { h = await createHarness(); });
beforeEach(() => h.reset());
after(() => h?.cleanup());
const check = (name, fn) => test(name, { timeout: 5000 }, fn);

check('Literal credentials survive Pi resolution without command execution or interpolation', async () => {
  const { composeModelProvider } = await import(pathToFileURL(path.join(h.piDir, 'dist/core/provider-composer.js')).href);
  for (const key of ['!printf SHOULD_NOT_RUN', '$SYNTHETIC_SECRET', '$' + '{SYNTHETIC_SECRET}', '$!', '$$NAME', 'literal!$value', 'normal-key']) {
    const entry = provider();
    entry.apiKey = key;
    let registration;
    const pi = { registerProvider: (_name, config) => { registration = config; }, unregisterProvider() {} };
    h.providers.registerProviderFor(pi, 'alpha', entry);
    const composed = composeModelProvider('alpha', undefined, { getProvider: () => undefined }, registration);
    const resolved = await composed.auth.apiKey.resolve({ ctx: { env: async () => 'unexpected-interpolation' } });
    assert.equal(resolved.auth.apiKey, key);
  }
});

check('Environment credentials are explicit and missing values fail clearly', async () => {
  const variable = 'PI_AI_MANAGER_TEST_KEY';
  const previous = process.env[variable];
  try {
    const entry = provider();
    entry.apiKeyEnv = variable;
    const m = h.manager();
    delete process.env[variable];
    await assert.rejects(h.providers.providerApiKey(m.ctx, 'alpha', entry), /not configured/);
    process.env[variable] = 'synthetic-environment-key';
    assert.equal(await h.providers.providerApiKey(m.ctx, 'alpha', entry), 'synthetic-environment-key');
    h.providers.registerProviderFor(m.pi, 'alpha', entry);
    assert.equal(m.registered.get('alpha').apiKey, '$' + '{PI_AI_MANAGER_TEST_KEY}');
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});

check('Discovery follows Pi runtime and stored auth precedence, including resolution errors', async () => {
  const m = h.manager();
  for (const source of ['runtime', 'stored']) {
    m.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source });
    m.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: 'synthetic-pi-key' } });
    assert.equal(await h.providers.providerApiKey(m.ctx, 'alpha', provider()), 'synthetic-pi-key');
    m.ctx.modelRegistry.getProviderAuth = async () => { throw new Error('synthetic credential resolution failed'); };
    await assert.rejects(h.providers.providerApiKey(m.ctx, 'alpha', provider()), /resolution failed/);
  }
});

check('Clearing a configured key removes the previous registration key', () => {
  const m = h.manager();
  const entry = provider();
  delete entry.apiKey;
  h.providers.registerProviderFor(m.pi, 'alpha', entry);
  assert.equal(m.registered.get('alpha').apiKey, undefined);
  assert.ok(m.events.some(event => event.type === 'unregister' && event.name === 'alpha'));
});

check('A draft that clears its key cannot reuse the old registration for discovery', async () => {
  const m = h.manager();
  const entry = provider();
  delete entry.apiKey;
  m.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: 'synthetic-old-key' } });
  assert.equal(await h.providers.providerApiKey(m.ctx, 'alpha', entry), undefined);
  assert.equal(h.providers.hasProviderAuth(m.ctx, 'alpha', entry), false);
});

check('Remote HTTP and URL credentials are rejected before any network request', async () => {
  for (const url of ['http://remote.invalid', 'http://127.attacker.invalid', 'https://user:secret@remote.invalid',
    'https://remote.invalid?api_key=synthetic', 'https://remote.invalid#fragment', 'file:///tmp/models']) {
    await assert.rejects(h.net.fetchModelList(url, 'synthetic-key'), /HTTPS/);
  }
});

check('HTTPS, true loopback and explicit HTTP opt-in are accepted without redirects', async () => {
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return discovery([]); };
  for (const url of ['https://remote.invalid/v1/', 'http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) {
    await h.net.fetchModelList(url, 'synthetic-key');
  }
  await h.net.fetchModelList('http://remote.invalid', 'synthetic-key', { allowInsecureHttp: true });
  assert.equal(calls[0].url, 'https://remote.invalid/v1/models');
  assert.equal(calls.length, 5);
  for (const { init } of calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
  }
});

check('Discovery rejects terminal controls, reserved IDs and duplicates without prototype mutation', async () => {
  const ids = ['gpt-5.4', 'gpt-5.4', '__proto__', 'constructor', 'prototype', '\x1b]52;c;dGVzdA==\x07',
    'gpt-\u202eevil', 'bad\nline', ' ', 'x'.repeat(513), '供应商/模型-1'];
  global.fetch = async () => discovery(ids.map(id => ({ id, supported_endpoint_types: ['__proto__', 'constructor', 'openai'] })));
  const list = await h.net.fetchModelList('https://remote.invalid', undefined);
  assert.deepEqual(list.map(model => model.id), ['gpt-5.4', '供应商/模型-1']);
  const entry = provider();
  const prototype = Object.getPrototypeOf(entry.models);
  h.providers.applyDiscovery(entry, list);
  h.providers.applyDiscovery(entry, [{ id: '__proto__', types: [] }]);
  assert.equal(Object.getPrototypeOf(entry.models), prototype);
  assert.equal(Object.hasOwn(entry.models, '__proto__'), false);
  assert.equal(Object.prototype.polluted, undefined);
  const malicious = JSON.parse('{"version":1,"providers":{"__proto__":{"baseUrl":"https://evil.invalid"},"alpha":{"baseUrl":"https://safe.invalid","models":{"__proto__":{"api":"openai-completions"}}}}}');
  const normalized = h.cfg.normalizeConfig(malicious);
  assert.equal(Object.getPrototypeOf(normalized.providers), null);
  assert.equal(Object.keys(normalized.providers.alpha.models).length, 0);
});

check('Discovery accepts only finite, positive, bounded integer model limits', async () => {
  global.fetch = async () => discovery([
    { id: 'bad', context_window: -1, max_tokens: 2.5 },
    { id: 'huge', max_context: 10000001, max_tokens: 1e99 },
    { id: 'valid', max_context: 64000, max_tokens: 2000, supports_reasoning: false },
  ]);
  const list = await h.net.fetchModelList('https://remote.invalid', undefined);
  for (const item of list.slice(0, 2)) {
    assert.equal(item.contextWindow, undefined);
    assert.equal(item.maxTokens, undefined);
  }
  assert.equal(list[2].contextWindow, 64000);
  assert.equal(list[2].maxTokens, 2000);
  assert.equal(list[2].reasoning, false);
});

check('Declared and streamed oversized responses are rejected without retry', async () => {
  const { MAX_RESPONSE_BYTES } = h.load('security');
  for (const declared of [true, false]) {
    let requests = 0;
    global.fetch = async () => {
      requests++;
      return declared
        ? new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })
        : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); controller.close(); } }));
    };
    await assert.rejects(h.net.fetchWithRetry('https://remote.invalid', {}, 200), /exceeds 5 MiB/);
    assert.equal(requests, 1);
  }
});

check('Discovery caps model count and rejects malformed payloads', async () => {
  for (const data of ['not JSON', '{}', 'null', JSON.stringify({ data: Array.from({ length: 10001 }, (_, i) => ({ id: 'model-' + i })) })]) {
    global.fetch = async () => new Response(data);
    await assert.rejects(h.net.fetchModelList('https://remote.invalid', undefined), /invalid JSON|data array|10,000/);
  }
});

check('The discovery deadline covers a stalled response body and cancels the reader', async () => {
  let cancelled = false;
  let signal;
  global.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  await assert.rejects(h.net.fetchWithTimeout('https://remote.invalid', {}, 20), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

check('Pre-aborted requests never fetch; abort interrupts Retry-After and rate limiting', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.net.fetchWithRetry('https://remote.invalid', { signal: controller.signal }, 50), /abort/i);
  let requests = 0;
  const started = deferred();
  const next = new AbortController();
  global.fetch = async () => { requests++; started.resolve(); return new Response('', { status: 429, headers: { 'retry-after': '30' } }); };
  const request = h.net.fetchWithRetry('https://remote.invalid', { signal: next.signal }, 100);
  await started.promise;
  next.abort();
  await assert.rejects(request, /abort/i);
  assert.equal(requests, 1);
  const limiter = new h.net.RateLimiter(10000);
  await limiter.acquire();
  const limitedController = new AbortController();
  const waiting = limiter.acquire(limitedController.signal);
  limitedController.abort();
  await assert.rejects(waiting, /abort/i);
  assert.equal(h.net.parseRetryAfter(null), undefined);
  assert.equal(h.net.parseRetryAfter('0'), 0);
  assert.equal(h.net.parseRetryAfter('99999'), 30000);
});

check('SDK catalogue metadata is used and unknown model limits stay conservative', () => {
  const knownProvider = h.compat.getProviders().find(name => h.compat.getModels(name).some(model => model.contextWindow > 0));
  const known = h.compat.getModels(knownProvider).find(model => model.contextWindow > 0);
  const entry = provider();
  const knownId = knownProvider + '/' + known.id;
  entry.models[knownId] = { api: 'openai-completions' };
  entry.models['unknown-synthetic-model'] = { api: 'openai-completions' };
  let [model, unknown] = h.providers.buildModelConfigs(entry, [knownId, 'unknown-synthetic-model']);
  assert.equal(model.contextWindow, known.contextWindow);
  assert.equal(model.maxTokens, Math.min(known.maxTokens, known.contextWindow));
  assert.deepEqual(model.input, known.input);
  assert.equal(model.reasoning, known.reasoning);
  assert.equal(unknown.contextWindow, 32768);
  assert.equal(unknown.maxTokens, 8192);
  assert.deepEqual(unknown.input, ['text']);
  entry.models['unknown-synthetic-model'].contextWindow = 2000;
  entry.models['unknown-synthetic-model'].maxTokens = 4000;
  entry.models['unknown-synthetic-model'].cost = { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 };
  [unknown] = h.providers.buildModelConfigs(entry, ['unknown-synthetic-model']);
  assert.equal(unknown.maxTokens, 2000);
  assert.equal(unknown.cost.output, 3);
});

check('Protocol-derived compatibility is recomputed after a protocol change', () => {
  const entry = provider();
  entry.models['deepseek-v4-flash'] = { api: 'openai-completions', reasoning: true };
  let [model] = h.providers.buildModelConfigs(entry, ['deepseek-v4-flash']);
  assert.equal(model.compat.thinkingFormat, 'deepseek');
  entry.models['deepseek-v4-flash'].api = 'anthropic-messages';
  [model] = h.providers.buildModelConfigs(entry, ['deepseek-v4-flash']);
  assert.equal(model.compat?.thinkingFormat, undefined);
});

check('Routing regexes reject nested repetition and glob matching cannot backtrack exponentially', () => {
  const rules = h.net.compileOverrides({ '(a+)+$': 'openai-responses', 'a*a*a*$': 'openai-responses',
    '^(a|aa)+$': 'openai-responses', 'a?a?a?aaa$': 'openai-responses', '(a|a)(a|a)$': 'openai-responses',
    '^gpt-': 'openai-completions', '^model\\.1$': 'anthropic-messages' });
  assert.equal(rules.length, 2);
  assert.equal(h.net.applyOverride('model.1', 'openai-responses', rules), 'anthropic-messages');
  const { matchesGlob } = h.load('utils');
  assert.equal(matchesGlob('a'.repeat(500) + 'b', '*a'.repeat(200) + '*c'), false);
  assert.equal(matchesGlob('gpt-5.4', 'gpt-?.4'), true);
});

check('Unicode typing, clearing, backspace and pasted control stripping are safe', () => {
  const { TextInput } = h.load('tui-input');
  const input = new TextInput();
  assert.equal(input.handleInput('中文😀'), 'typed');
  input.handleInput('\x7f');
  assert.equal(input.value, '中文');
  input.handleInput('\x15');
  assert.equal(input.value, '');
  input.handleInput('\x1b[200~a\n中\x1b]52;c;test\x07\x1b[201~');
  assert.equal(/[\x00-\x1f\x7f]/.test(input.value), false);
  input.value = 'x'.repeat(5000);
  assert.equal(input.value.length, 4096);
  input.clear();
  input.handleInput('\x1b[200~' + 'a'.repeat(17000));
  assert.equal(input.value, '');
});

check('Error messages strip secrets and terminal controls before display', () => {
  const { safeError } = h.load('security');
  const clean = safeError(new Error('synthetic-secret Bearer token-other sk-testvalue \x1b]52;c;payload\x07'), ['synthetic-secret']);
  assert.equal(clean.includes('synthetic-secret'), false);
  assert.equal(clean.includes('token-other'), false);
  assert.equal(clean.includes('sk-testvalue'), false);
  assert.equal(/[\x00-\x1f\x7f]/.test(clean), false);
  const { ErrorHandler } = h.load('error-handler');
  const messages = [];
  const original = console.warn;
  console.warn = (...values) => messages.push(values.join(' '));
  try { new ErrorHandler().record('recoverable', 'TEST', 'Bearer synthetic-secret\x1b]52;c;test\x07'); }
  finally { console.warn = original; }
  assert.equal(messages[0].includes('synthetic-secret'), false);
  assert.equal(messages[0].includes('\x1b'), false);
});

check('Cancelled or skipped tests do not change health, and failures do not pollute latency', async () => {
  const entry = provider();
  const meta = entry.models['gpt-5.4'];
  h.testing.applyTestResultToMeta(meta, { passed: 0, total: 3, skipped: true, reasons: ['aborted'] });
  assert.equal(meta.health, undefined);
  const m = h.manager();
  const originalNow = Date.now;
  let time = originalNow();
  let calls = 0;
  Date.now = () => time;
  m.ctx.modelRegistry.complete = async () => {
    calls++;
    if (calls === 1) { time += 100; return validResponse(); }
    time += 5;
    throw new Error('synthetic failure');
  };
  try {
    const result = await h.testing.testModel(m.ctx, 'alpha', 'gpt-5.4', ['one', 'two'], new h.net.RateLimiter(0));
    assert.equal(result.passed, 1);
    assert.equal(result.total, 2);
    assert.equal(result.metrics.avgResponseTime, 100);
    assert.equal(result.metrics.minResponseTime, 100);
  } finally { Date.now = originalNow; }
});

check('Dedup retains meaningful variant suffixes and stale health loses its healthy rank', () => {
  const { normalizeModelName, compareInstances } = h.load('dedup');
  assert.notEqual(normalizeModelName('vendor/model-thinking'), normalizeModelName('model'));
  assert.notEqual(normalizeModelName('model-fast'), normalizeModelName('model'));
  assert.notEqual(normalizeModelName('model.1'), normalizeModelName('model-1'));
  const stale = { gateway: 'one', modelId: 'm', health: { status: 'healthy', lastCheck: Date.now() - 86400001 }, metrics: { avgResponseTime: 1 } };
  const fresh = { gateway: 'two', modelId: 'm', health: { status: 'healthy', lastCheck: Date.now() }, metrics: { avgResponseTime: 100 } };
  assert.ok(compareInstances(stale, fresh) > 0);
});

check('Atomic writes clean their temporary file on failure and never replace the target', () => {
  const { atomicWrite } = h.load('storage');
  const target = path.join(h.runDir, 'atomic-test.json');
  fs.writeFileSync(target, 'original');
  h.setRenameHook(() => { throw new Error('synthetic rename failure'); });
  try { assert.throws(() => atomicWrite(target, 'replacement'), /rename failure/); }
  finally { h.setRenameHook(undefined); }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.readdirSync(h.runDir).some(name => name.startsWith('atomic-test.json.tmp.')), false);
});
