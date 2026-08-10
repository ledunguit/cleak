// nest-cli's default webpack config (webpack-defaults.js) bundles the whole app
// into one `main.js` — fine for everything except the parse worker: Piscina's
// `new Worker(filename)` needs a real, standalone `.js` file on disk, which a
// single bundle can't provide. This adds a second entry, `workers/parse.worker`,
// emitted alongside `main.js` (see `CParserService.onModuleInit`'s worker-path
// resolution) without touching any of the other webpack defaults (ts-loader,
// externals, `node.__dirname: false`, etc. — shallow-merged in by nest-cli's
// WebpackCompiler, only the keys returned here are overridden).
const { join, dirname } = require('path');
const { writeFileSync } = require('fs');

// Root `package.json` declares `"type": "module"`, and there's no override
// under `dist/apps/static-analyzer/` — so if anything on the runtime host also
// has an ambient `package.json` above the dist output (e.g. running directly
// out of a full repo checkout, rather than Docker's minimal `/app` with no
// package.json at all), Node treats the compiled `.js` files as ESM and
// `require()` silently returns an empty module namespace instead of throwing —
// this is exactly what broke Piscina's `require(parse.worker.js)` (confirmed by
// testing locally; Docker happened to work only because its copied image has no
// ambient package.json to trigger the misdetection). Emitting an explicit
// `dist/apps/static-analyzer/package.json` with `"type": "commonjs"` makes the
// module type correct regardless of what surrounds the dist output.
class WriteCommonJsPackageJsonPlugin {
  constructor(relDir) {
    this.relDir = relDir;
  }
  apply(compiler) {
    compiler.hooks.afterEmit.tap('WriteCommonJsPackageJsonPlugin', (compilation) => {
      const target = join(compilation.options.output.path, this.relDir, 'package.json');
      writeFileSync(target, JSON.stringify({ type: 'commonjs' }, null, 2));
    });
  }
}

module.exports = (options) => {
  // `options.output.filename` is already `<relativeSourceRoot>/main.js` (e.g.
  // `apps/static-analyzer/main.js`) — derive the shared output directory from
  // it instead of hardcoding the project's root path a second time.
  const relDir = dirname(options.output.filename);
  return {
    entry: {
      main: options.entry,
      // `main.js` is executed directly (`node dist/main.js`), so it needs no
      // module.exports. The worker is `require()`d BY Piscina — without an
      // explicit CommonJS library target, webpack's default Node bootstrap
      // never assigns its exports back to the real `module.exports`, so
      // Piscina sees an empty object and fails with "No handler function
      // exported" even though the source has a `export default`.
      'workers/parse.worker': { import: join(__dirname, 'src/workers/parse.worker.ts'), library: { type: 'commonjs2' } },
    },
    output: {
      filename: join(relDir, '[name].js'),
    },
    plugins: [...(options.plugins || []), new WriteCommonJsPackageJsonPlugin(relDir)],
  };
};
