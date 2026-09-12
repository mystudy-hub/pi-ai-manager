const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');
const { test, before, beforeEach, after } = require('node:test');
const { createHarness, fixture, provider } = require('./harness.cjs');

let h;
before(async () => { h = await createHarness(); });
beforeEach(() => h.reset());
after(() => h?.cleanup());
const check = (name, fn) => test(name, { timeout: 5000 }, fn);
const settingsPath = () => path.join(h.runDir, 'settings.json');
const journalPath = () => path.join(h.runDir, 'extension-settings', 'provider-ai.pending.json');

check('Independent sessions merge model edits and preserve unrelated Pi settings', () => {
  fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'custom', enabledModels: ['foreign/model', 'alpha/gpt-5.4'] }));
  const base = h.cfg.readConfig();
  const first = h.cfg.cloneConfig(base);
  const second = h.cfg.cloneConfig(base);
  first.providers.alpha.models['gpt-5.4'].reasoning = true;
  second.providers.alpha.enabledModels = [];
  h.cfg.commitConfig(base, first);
  const merged = h.cfg.commitConfig(base, second);
  assert.equal(merged.providers.alpha.models['gpt-5.4'].reasoning, true);
  assert.deepEqual(merged.providers.alpha.enabledModels, []);
  assert.deepEqual(h.settings(), { theme: 'custom', enabledModels: ['foreign/model'] });
  assert.equal(fs.existsSync(journalPath()), false);
});

check('Concurrent changes to different enabled models merge as sets', () => {
  const input = fixture();
  input.providers.alpha.models['gpt-5.4-mini'] = { api: 'openai-completions' };
  h.reset(input);
  const base = h.cfg.readConfig();
  const first = h.cfg.cloneConfig(base);
  const second = h.cfg.cloneConfig(base);
  first.providers.alpha.enabledModels = [];
  second.providers.alpha.enabledModels.push('gpt-5.4-mini');
  h.cfg.commitConfig(base, first);
  const merged = h.cfg.commitConfig(base, second);
  assert.deepEqual(merged.providers.alpha.enabledModels, ['gpt-5.4-mini']);
});

check('Same-field conflicts keep the newer on-disk value', () => {
  const base = h.cfg.readConfig();
  const first = h.cfg.cloneConfig(base);
  const second = h.cfg.cloneConfig(base);
  first.providers.alpha.models['gpt-5.4'].contextWindow = 8000;
  second.providers.alpha.models['gpt-5.4'].contextWindow = 16000;
  h.cfg.commitConfig(base, first);
  const bytes = fs.readFileSync(h.cfg.configPath(), 'utf8');
  assert.throws(() => h.cfg.commitConfig(base, second), /conflict/);
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), bytes);
  assert.equal(fs.existsSync(journalPath()), false);
});

check('Concurrent endpoint and credential changes are rejected as one connection conflict', () => {
  const base = h.cfg.readConfig();
  const first = h.cfg.cloneConfig(base);
  const second = h.cfg.cloneConfig(base);
  first.providers.alpha.baseUrl = 'https://other.invalid';
  second.providers.alpha.apiKey = 'synthetic-rotated-key';
  h.cfg.commitConfig(base, first);
  assert.throws(() => h.cfg.commitConfig(base, second), /connection or credentials/);
  assert.equal(h.disk().providers.alpha.apiKey, base.providers.alpha.apiKey);
});

check('Unchanged sessions preserve new providers and cannot resurrect a deleted provider', () => {
  const base = h.cfg.readConfig();
  const current = h.cfg.cloneConfig(base);
  current.providers.beta = provider('beta');
  delete current.providers.alpha;
  h.cfg.commitConfig(base, current);
  const result = h.cfg.commitConfig(base, base);
  assert.equal(result.providers.alpha, undefined);
  assert.ok(result.providers.beta);
  assert.deepEqual(h.settings().enabledModels, ['beta/gpt-5.4']);
});

check('Simultaneous first health measurements keep the newest timestamp', () => {
  const base = h.cfg.readConfig();
  const first = h.cfg.cloneConfig(base);
  const second = h.cfg.cloneConfig(base);
  first.providers.alpha.models['gpt-5.4'].health = { status: 'healthy', lastCheck: 200, consecutiveFailures: 0 };
  second.providers.alpha.models['gpt-5.4'].health = { status: 'down', lastCheck: 100, consecutiveFailures: 1 };
  h.cfg.commitConfig(base, first);
  const result = h.cfg.commitConfig(base, second);
  assert.equal(result.providers.alpha.models['gpt-5.4'].health.status, 'healthy');
});

check('Provider and Pi settings locks prevent writes without leaving a journal', () => {
  for (const file of [h.cfg.configPath(), settingsPath()]) {
    const release = lockfile.lockSync(file, { realpath: false });
    const bytes = fs.readFileSync(h.cfg.configPath(), 'utf8');
    try {
      const base = h.cfg.readConfig();
      assert.throws(() => h.cfg.commitConfig(base, base), /Another process/);
      assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), bytes);
      assert.equal(fs.existsSync(journalPath()), false);
    } finally { release(); }
  }
});

check('Invalid Pi settings fail before saving and the TUI remains open', async () => {
  fs.writeFileSync(settingsPath(), '{invalid settings');
  const bytes = fs.readFileSync(h.cfg.configPath(), 'utf8');
  const m = h.manager();
  await m.tui.handleInput(' ');
  assert.equal(await m.tui.handleInput('\r'), true);
  assert.equal(m.tui.saved, false);
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), bytes);
  assert.ok(m.events.some(event => /settings.json is invalid/.test(event.message)));
});

check('A failed settings write is reported and journal replay completes both-file sync', () => {
  const base = h.cfg.readConfig();
  const draft = h.cfg.cloneConfig(base);
  draft.providers.alpha.enabledModels = [];
  h.setRenameHook((_from, to) => {
    if (path.resolve(to).toLowerCase().replace(/\\/g, '/') === path.resolve(settingsPath()).toLowerCase().replace(/\\/g, '/')) throw Object.assign(new Error('injected settings write failure'), { code: 'EIO' });
  });
  try { assert.throws(() => h.cfg.commitConfig(base, draft), /configuration was saved, but Pi settings sync failed/); }
  finally { h.setRenameHook(undefined); }
  assert.equal(fs.existsSync(journalPath()), true);
  const journal = fs.readFileSync(journalPath(), 'utf8');
  assert.deepEqual(JSON.parse(journal), { providers: ['alpha'] });
  assert.equal(journal.includes(base.providers.alpha.apiKey), false);
  assert.deepEqual(h.disk().providers.alpha.enabledModels, []);
  h.cfg.readConfig();
  assert.equal(h.settings().enabledModels, undefined);
  assert.equal(fs.existsSync(journalPath()), false);
});

check('Recovery journal removes obsolete managed scopes and preserves foreign settings', () => {
  fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'light', enabledModels: ['removed/*', 'foreign/*'] }));
  fs.writeFileSync(journalPath(), JSON.stringify({ providers: ['removed', 'alpha'] }));
  h.cfg.readConfig();
  assert.deepEqual(h.settings(), { theme: 'light', enabledModels: ['foreign/*', 'alpha/gpt-5.4'] });
});

check('Corrupt config without a valid backup is preserved and raises an error', () => {
  fs.writeFileSync(h.cfg.configPath(), '{synthetic-corrupt-config');
  assert.throws(() => h.cfg.readConfig(), /original file was kept/);
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), '{synthetic-corrupt-config');
});

check('Recovery skips structurally invalid backups before replaying a pending journal', () => {
  const recovery = h.load('config-v2').getConfigRecoveryInstance();
  const valid = recovery.backup(h.cfg.configPath());
  assert.ok(valid);
  fs.writeFileSync(path.join(path.dirname(valid.path), `provider-ai.backup.${Date.now() + 10000}.json`), JSON.stringify({ version: 999, providers: [] }));
  fs.writeFileSync(h.cfg.configPath(), '{corrupt');
  fs.writeFileSync(journalPath(), JSON.stringify({ providers: ['alpha'] }));
  assert.ok(h.cfg.readConfig().providers.alpha);
  assert.equal(fs.existsSync(journalPath()), false);
});

check('Backups share the isolated agent directory, use unique names, and restrict key access', () => {
  const recovery = h.load('config-v2').getConfigRecoveryInstance();
  for (let i = 0; i < 12; i++) recovery.backup(h.cfg.configPath());
  const backups = recovery.listBackups();
  assert.equal(backups.length, 10);
  assert.equal(new Set(backups.map(item => item.path)).size, 10);
  for (const item of backups) {
    assert.ok(item.path.startsWith(path.join(h.runDir, 'extension-settings', 'backups')));
    if (process.platform !== 'win32') assert.equal(fs.statSync(item.path).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(h.cfg.configPath()).mode & 0o777, 0o600);
});

check('Legacy remote HTTP entries stay editable but registration refuses implicit HTTP', () => {
  const input = fixture();
  input.providers.alpha.baseUrl = 'http://legacy.invalid';
  h.reset(input);
  const read = h.cfg.readConfig();
  assert.equal(read.providers.alpha.baseUrl, 'http://legacy.invalid');
  assert.throws(() => h.providers.registerProviderFor({ registerProvider() {}, unregisterProvider() {} }, 'alpha', read.providers.alpha), /HTTPS/);
});

check('Config normalization retains thinking overrides, bounds settings and rejects invalid token limits', () => {
  const input = fixture();
  Object.assign(input.providers.alpha.models['gpt-5.4'], {
    thinkingLevelMap: { high: 'custom' }, thinkingMode: 'enabled', thinkingEffort: 'high',
    compat: { supportsStore: false }, maxTokens: Infinity, contextWindow: -1,
    cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  });
  input.settings.testConcurrency = 9999;
  input.settings.testRequestDelayMs = 99999;
  const read = h.cfg.normalizeConfig(input);
  const meta = read.providers.alpha.models['gpt-5.4'];
  assert.deepEqual(meta.thinkingLevelMap, { high: 'custom' });
  assert.equal(meta.thinkingMode, 'enabled');
  assert.equal(meta.thinkingEffort, 'high');
  assert.deepEqual(meta.compat, { supportsStore: false });
  assert.deepEqual(meta.cost, { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 });
  assert.equal(meta.maxTokens, undefined);
  assert.equal(meta.contextWindow, undefined);
  assert.equal(read.settings.testConcurrency, 10);
  assert.equal(read.settings.testRequestDelayMs, 10000);
});

check('Owned wildcard scopes are reclaimed when shrinking or deleting a gateway', () => {
  const many = Array.from({ length: 51 }, (_, i) => `model-${i}`);
  assert.deepEqual(h.cfg.computeScopedPatterns(['foreign/*'], 'alpha', many), ['foreign/*', 'alpha/*']);
  assert.deepEqual(h.cfg.computeScopedPatterns(['foreign/*', 'alpha/*'], 'alpha', ['one']), ['foreign/*', 'alpha/one']);
  assert.deepEqual(h.cfg.computeScopedPatterns(['alpha/one:high', 'foreign/*', '*gpt*'], 'alpha', []), ['foreign/*', '*gpt*']);
});
