import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'node-pty'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/banner-preload.ts'], outfile: 'dist/banner-preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer.js', platform: 'browser', format: 'iife' }),
]);
copyFileSync('src/renderer/index.html', 'dist/index.html');
console.log('built dist/');
