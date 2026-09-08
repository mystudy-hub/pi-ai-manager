import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { test, before, beforeEach, after } from 'node:test';
import harness from './harness.cjs';

let h;
before(async () => { h = await harness.createHarness(); });
beforeEach(() => h.reset());
after(() => h?.cleanup());

function entrypoint() {
  const loaded = h.load('index');
  return loaded.default ?? loaded;
}

test('Extension loads into the installed Pi runtime and preserves global TLS defaults', { timeout: 10000 }, async () => {
  const { ModelRuntime } = await import(pathToFileURL(path.join(h.piDir, 'dist/core/model-runtime.js')).href);
  const { ModelRegistry } = await import(pathToFileURL(path.join(h.piDir, 'dist/core/model-registry.js')).href);
  const runtime = await ModelRuntime.create({
    authPath: path.join(h.runDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: path.join(h.runDir, 'model-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const commands = new Map();
  const pi = {
    registerCommand: (name, config) => commands.set(name, config),
    registerProvider: (name, config) => registry.registerProvider(name, config),
    unregisterProvider: name => registry.unregisterProvider(name),
  };
  const curve = tls.DEFAULT_ECDH_CURVE;
  entrypoint()(pi);
  assert.equal(tls.DEFAULT_ECDH_CURVE, curve);
  assert.equal(typeof commands.get('ai-manager').handler, 'function');
  const model = registry.find('alpha', 'gpt-5.4');
  assert.equal(model.baseUrl, 'https://alpha.invalid/v1');
  assert.equal(model.contextWindow, 4096);
  assert.equal(model.maxTokens, 4096);
  assert.equal(await registry.getApiKeyForProvider('alpha'), 'synthetic-key-alpha');
  await runtime.setRuntimeApiKey('alpha', 'synthetic-runtime-key');
  assert.equal(await h.providers.providerApiKey({ modelRegistry: registry }, 'alpha', harness.provider()), 'synthetic-runtime-key');
  await runtime.removeRuntimeApiKey('alpha');
  const withoutKey = harness.provider();
  delete withoutKey.apiKey;
  h.providers.registerProviderFor(pi, 'alpha', withoutKey);
  assert.equal(await registry.getApiKeyForProvider('alpha'), undefined);
});

test('An invalid provider does not prevent other providers or the command from loading', () => {
  const input = harness.fixture(true);
  input.providers.alpha.baseUrl = 'http://legacy.invalid';
  h.reset(input);
  const registered = [];
  const commands = [];
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  try {
    entrypoint()({
      registerProvider: name => registered.push(name),
      unregisterProvider() {},
      registerCommand: name => commands.push(name),
    });
  } finally { console.error = original; }
  assert.deepEqual(registered, ['beta']);
  assert.deepEqual(commands, ['ai-manager']);
  assert.ok(errors.some(message => /could not register alpha/.test(message)));
  assert.ok(h.disk().providers.alpha);
});

test('Corrupt configuration still leaves the command registered and reports a recoverable error', async () => {
  fs.writeFileSync(h.cfg.configPath(), '{synthetic-corrupt');
  let command;
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  try {
    entrypoint()({ registerCommand: (_name, config) => { command = config; }, registerProvider() {}, unregisterProvider() {} });
  } finally { console.error = original; }
  assert.equal(typeof command.handler, 'function');
  const notices = [];
  await command.handler('', { mode: 'tui', ui: { notify: message => notices.push(message) } });
  assert.ok(errors.some(message => /original file was kept/.test(message)));
  assert.ok(notices.some(message => /original file was kept/.test(message)));
  assert.equal(fs.readFileSync(h.cfg.configPath(), 'utf8'), '{synthetic-corrupt');
});

test('The command rejects non-TUI invocation without opening a component', async () => {
  let command;
  h.load('commands').registerCommands({ registerCommand: (_name, config) => { command = config; } });
  const notices = [];
  await command.handler('', { mode: 'rpc', ui: { notify: message => notices.push(message) } });
  assert.match(notices[0], /requires TUI/);
});
