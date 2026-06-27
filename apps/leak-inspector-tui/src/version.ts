/**
 * The CLI version. tsup injects `__CLEAK_VERSION__` from package.json at build
 * time (see tsup.config.ts `define`), so the published binary always reports the
 * real package version. Under dev (`bun src/cli.ts`, no define) the identifier is
 * absent — `typeof` keeps that safe — and we fall back to a dev sentinel.
 */
declare const __CLEAK_VERSION__: string | undefined;

export const VERSION: string =
  typeof __CLEAK_VERSION__ !== 'undefined' ? __CLEAK_VERSION__ : '0.0.0-dev';
