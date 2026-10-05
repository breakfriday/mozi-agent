const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

module.exports = function createLoader(overrides = {}) {
  const cache = new Map();
  const context = vm.createContext({
    console, URL, TextEncoder, Buffer, setTimeout, clearTimeout, setImmediate, structuredClone,
    crypto: require("node:crypto").webcrypto,
    process: { env: {} },
  });
  function load(filename) {
    const resolved = [filename, `${filename}.ts`, path.join(filename, "index.ts")]
      .find((candidate) => existsSync(candidate) && require("node:fs").statSync(candidate).isFile());
    if (!resolved) throw new Error(`Cannot resolve ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const { outputText } = ts.transpileModule(readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const execute = vm.runInContext(`(function(require, module, exports) {\n${outputText}\n})`, context, { filename: resolved });
    execute((name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith(".")) return load(path.resolve(path.dirname(resolved), name));
      return require(name);
    }, module, module.exports);
    // Tests opt into tracing with a capture sink; keep routine suites quiet.
    if (resolved.endsWith(`${path.sep}shared${path.sep}agent${path.sep}logging.ts`)) {
      module.exports.configureAgentLogging({ enabled: false });
    }
    return module.exports;
  }
  return load;
};
