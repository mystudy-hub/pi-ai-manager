const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

function resolvePiPackageDir() {
  const candidates = [process.env.PI_CODING_AGENT_PACKAGE_DIR];
  try { candidates.push(path.dirname(require.resolve('@earendil-works/pi-coding-agent'))); } catch {}
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    try { candidates.push(path.dirname(fs.realpathSync(path.join(directory, process.platform === 'win32' ? 'pi.cmd' : 'pi')))); } catch {}
  }
  for (const candidate of candidates.filter(Boolean)) {
    let directory = candidate;
    for (let i = 0; i < 10; i++) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === '@earendil-works/pi-coding-agent') return directory;
      } catch {}
      if (path.dirname(directory) === directory) break;
      directory = path.dirname(directory);
    }
  }
  throw new Error('Install Pi or set PI_CODING_AGENT_PACKAGE_DIR before running tests.');
}

function provider(name = 'alpha') {
  return { baseUrl: `https://${name}.invalid`, apiKey: `synthetic-key-${name}`, defaultApi: 'openai-completions',
    models: { 'gpt-5.4': { api: 'openai-completions', contextWindow: 4096, reasoning: false } }, enabledModels: ['gpt-5.4'] };
}
function fixture(two = false) {
  return { version: 1, providers: { alpha: provider(), ...(two ? { beta: provider('beta') } : {}) },
    settings: { testRequestDelayMs: 0, testConcurrency: 1, testQuestions: ['Answer OK'] } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function validResponse() { return { content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 2, output: 1 } }; }
function discovery(data = []) { return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } }); }

async function createHarness() {
  const root = path.resolve(__dirname, '..');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ai-manager-test-'));
  process.env.PI_CODING_AGENT_DIR = runDir;
  process.env.PI_EXTENSION_SETTINGS_DIR = path.join(runDir, 'extension-settings');
  const piDir = resolvePiPackageDir();
  const piRequire = createRequire(path.join(piDir, 'package.json'));
  const tui = await import(pathToFileURL(piRequire.resolve('@earendil-works/pi-tui')).href);
  // pi-ai exposes import-only entrypoints; require.resolve uses the wrong condition.
  const aiDir = piRequire.resolve.paths('@earendil-works/pi-ai')
    .map(directory => path.join(directory, '@earendil-works/pi-ai'))
    .find(directory => fs.existsSync(path.join(directory, 'package.json')));
  if (!aiDir) throw new Error('Pi installation is missing pi-ai');
  const aiManifest = JSON.parse(fs.readFileSync(path.join(aiDir, 'package.json'), 'utf8'));
  const compat = await import(pathToFileURL(path.join(aiDir, aiManifest.exports['./compat'].import)).href);
  const { createJiti } = piRequire('jiti');
  let renameHook;
  const transpiler = createJiti(__filename, { fsCache: false, tryNative: false });
  const jiti = createJiti(__filename, { fsCache: false, moduleCache: true, tryNative: false,
    // Jiti resolves built-ins before virtual modules. Route only storage's fs import
    // through a delegating wrapper so I/O failure tests do not patch process-wide fs.
    transform: options => ({ code: transpiler.transform({ ...options,
      source: (options.filename && options.filename.replace(/\\/g, '/').endsWith('/src/storage.ts'))
        ? options.source.replace('"node:fs"', '"test:fs"') : options.source,
    }) }),
    virtualModules: {
    '@earendil-works/pi-coding-agent': { getAgentDir: () => runDir },
    '@earendil-works/pi-tui': tui, '@earendil-works/pi-ai/compat': compat,
    'test:fs': { ...fs, renameSync: (from, to) => { renameHook?.(from, to); return fs.renameSync(from, to); } },
  } });
  const load = name => jiti(path.join(root, 'src', name + '.ts'));
  const cfg = load('config');
  const providers = load('provider');
  const { RelayManagerTUI } = load('tui');
  const originalFetch = global.fetch;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const disk = () => JSON.parse(fs.readFileSync(cfg.configPath(), 'utf8'));
  const settings = () => JSON.parse(fs.readFileSync(path.join(runDir, 'settings.json'), 'utf8'));
  function reset(input = fixture()) {
    renameHook = undefined;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    cfg.writeConfigSync(input);
    fs.writeFileSync(path.join(runDir, 'settings.json'), JSON.stringify({ enabledModels: ['alpha/gpt-5.4'] }));
    global.fetch = async () => { throw new Error('Unexpected network request in test'); };
  }
  function manager(input = cfg.readConfig(), complete = async () => validResponse()) {
    const events = [];
    const registered = new Map();
    let component;
    let finish;
    let renderRequests = 0;
    let customOptions;
    const terminal = { rows: 24 };
    const pi = {
      registerProvider: (name, config) => { registered.set(name, { ...registered.get(name), ...config }); events.push({ type: 'register', name, config }); },
      unregisterProvider: name => { registered.delete(name); events.push({ type: 'unregister', name }); },
    };
    for (const [name, entry] of Object.entries(input.providers)) providers.registerProviderFor(pi, name, entry);
    const ctx = { mode: 'tui', ui: {
      notify: (message, level) => events.push({ type: 'notify', message, level }),
      setStatus: () => {},
      custom: (factory, options) => new Promise(resolve => { customOptions = options; finish = resolve; component = factory({ terminal, requestRender: () => { renderRequests++; } }, theme, {}, resolve); }),
    }, modelRegistry: {
      getProviderAuthStatus: name => ({ configured: registered.has(name) }),
      getProvider: name => registered.get(name),
      getRegisteredProviderConfig: name => registered.get(name),
      getApiKeyForProvider: async () => undefined,
      getProviderAuth: async () => undefined,
      find: (name, id) => {
        const model = registered.get(name)?.models.find(model => model.id === id);
        return model ? { ...model, provider: name } : undefined;
      }, complete,
    } };
    const instance = new RelayManagerTUI(ctx, pi, input);
    return { tui: instance, events, registered, pi, ctx, terminal, get customOptions() { return customOptions; }, get config() { return instance.config; },
      get component() { return component; }, get renderRequests() { return renderRequests; }, finish: value => finish?.(value) };
  }
  return { root, runDir, piDir, piRequire, compat, jiti, load, cfg, providers, net: load('network'), testing: load('testing'),
    setRenameHook: hook => { renameHook = hook; },
    theme, tuiSdk: tui, manager, reset, disk, settings, cleanup: () => { global.fetch = originalFetch; fs.rmSync(runDir, { recursive: true, force: true }); } };
}

module.exports = { createHarness, resolvePiPackageDir, fixture, provider, deferred, validResponse, discovery };
