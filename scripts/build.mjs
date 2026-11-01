// Builds dist/, the static assets the Worker serves: public/ as it is, plus
// the app (src/app/app.ts), stylesheet (src/app/styles.css) and the small
// theme script for <head> (src/app/theme-head.ts, a classic script) bundled
// by esbuild, with a content hash in their names so a deploy never mixes a
// new page with old code (the apphub.casa zone caches CSS/JS for 4 hours).
// The HTML pages refer to /app.js, /styles.css and /theme.js; those
// references are rewritten to the hashed names. The Worker itself is
// bundled by wrangler.
//
//   node scripts/build.mjs        (npm run build; wrangler dev runs it too)
import { build } from 'esbuild';
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const OUT = 'dist';
const ENTRIES = { '/app.js': 'src/app/app.ts', '/styles.css': 'src/app/styles.css', '/theme.js': 'src/app/theme-head.ts' };

rmSync(OUT, { recursive: true, force: true });
cpSync('public', OUT, { recursive: true });

const common = {
  bundle: true,
  target: 'es2022',
  minify: true,
  sourcemap: 'linked',
  outdir: OUT,
  entryNames: '[name]-[hash]',
  // Fonts and icons are plain files in public/, referenced by absolute URL.
  external: ['/fonts/*', '/icons/*'],
  metafile: true,
  logLevel: 'warning',
};
const results = await Promise.all([
  build({ ...common, entryPoints: { app: ENTRIES['/app.js'], styles: ENTRIES['/styles.css'] }, format: 'esm' }),
  // Runs before the page paints, so not a module (those are deferred).
  build({ ...common, entryPoints: { theme: ENTRIES['/theme.js'] }, format: 'iife' }),
]);

const hashed = {};
for (const [file, output] of results.flatMap((r) => Object.entries(r.metafile.outputs))) {
  for (const [url, entry] of Object.entries(ENTRIES)) {
    if (output.entryPoint === entry) hashed[url] = `/${basename(file)}`;
  }
}

for (const page of readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
  let html = readFileSync(`${OUT}/${page}`, 'utf8');
  for (const [url, name] of Object.entries(hashed)) {
    html = html.replaceAll(`"${url}"`, `"${name}"`);
  }
  for (const url of Object.keys(ENTRIES)) {
    if (html.includes(`"${url}"`)) throw new Error(`${page}: ${url} was not rewritten`);
  }
  writeFileSync(`${OUT}/${page}`, html);
}

if (Object.keys(hashed).length !== Object.keys(ENTRIES).length) throw new Error(`missing outputs: ${JSON.stringify(hashed)}`);
console.log(`built ${OUT}/: ${Object.values(hashed).join(', ')}`);
