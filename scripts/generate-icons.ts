// Regenerates public/icons/icon-{16,32,48,128}.png from the editable SVG
// sources in assets-src/. The 16/32/48 toolbar sizes use icon-16.svg and
// icon.svg; the 128 px icon, which the Chrome Web Store also shows, uses the
// padded icon-store.svg (96x96 artwork, 16 px transparent padding per side),
// and its transparent margin is measured before it is written. Run with `npm run icons` after editing an SVG and
// commit the PNGs: the build copies them from public/ and never renders SVG.
//
// Rendering uses Playwright's bundled Chromium (a dev dependency already used
// by the browser tests); nothing is downloaded and the extension gains no
// runtime dependency. Each size is rendered directly at its pixel size, so no
// image is scaled after rasterisation.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { readPngSize } from './beta/png.ts';
import { measureStoreIcon } from './store/checks.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'public', 'icons');
/**
 * Source SVG for each size. 16 px has a simplified, pixel-aligned drawing;
 * 128 px is the store-sized variant with transparent padding.
 */
const SOURCES: Record<number, string> = { 16: 'icon-16.svg', 32: 'icon.svg', 48: 'icon.svg', 128: 'icon-store.svg' };

const browser = await chromium.launch();
try {
  await mkdir(OUT, { recursive: true });
  for (const [sizeText, file] of Object.entries(SOURCES)) {
    const size = Number(sizeText);
    const svg = await readFile(join(ROOT, 'assets-src', file), 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="${src}">`,
    );
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    const actual = readPngSize(png);
    if (actual.width !== size || actual.height !== size) throw new Error(`icon-${size}.png rendered at ${actual.width}x${actual.height}`);
    let note = '';
    if (size === 128) {
      const m = measureStoreIcon(png);
      const b = m.alphaBounds;
      note = `  artwork x ${b.left}-${b.right}, y ${b.top}-${b.bottom} (${m.artworkWidth}x${m.artworkHeight}), transparent margin >= ${m.minTransparentMargin} px`;
    }
    await writeFile(join(OUT, `icon-${size}.png`), png);
    console.log(`public/icons/icon-${size}.png  ${size}x${size}  ${png.length} bytes${note}`);
  }
} finally {
  await browser.close();
}
