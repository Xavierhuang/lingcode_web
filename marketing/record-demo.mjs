// record-demo.mjs — Playwright recorder for /try.html?demo=1&embed=1.
//
// Usage:
//   cd website/marketing
//   npm install
//   node record-demo.mjs                    # records production at lingcode.dev
//   TARGET=http://localhost:8765 node record-demo.mjs   # local
//
// Output: out/demo-<timestamp>.webm  (Playwright native format)
//         out/demo-<timestamp>.mp4   (re-encoded via ffmpeg if available)
//
// The demo URL drives itself — no Playwright clicks/typing required, just
// navigate and record. ?slowmo=5 stretches the ~10s scripted race to ~50s
// so the captured clip lands at the target ~60s with intro+outro padding.

import { chromium } from 'playwright';
import { mkdirSync, renameSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
mkdirSync(OUT_DIR, { recursive: true });

// ─── Config ──────────────────────────────────────────────────────────
const TARGET     = process.env.TARGET || 'https://lingcode.dev';
const SCENARIO   = process.env.SCENARIO || 'snake';   // ?task=<id>
const SLOWMO     = Number(process.env.SLOWMO || 5);   // ?slowmo=N
// Total record duration in seconds. Should be slightly longer than the
// race + endcard so the final shot is captured.
const RECORD_S   = Number(process.env.RECORD_S || 60);
const VIEWPORT   = { width: 1080, height: 1920 };

const url = `${TARGET}/try.html?demo=1&embed=1&slowmo=${SLOWMO}&task=${encodeURIComponent(SCENARIO)}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

console.log(`▶ Recording ${url}`);
console.log(`  viewport: ${VIEWPORT.width}x${VIEWPORT.height}, duration: ${RECORD_S}s`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT_DIR, size: VIEWPORT },
});
const page = await ctx.newPage();
// Prevent console noise from spamming the terminal but surface errors.
page.on('pageerror', (err) => console.warn('  [page error]', err.message));

await page.goto(url, { waitUntil: 'load' });
console.log('  ✓ page loaded; recording…');
await page.waitForTimeout(RECORD_S * 1000);

const video = page.video();
await page.close();
await ctx.close();
await browser.close();

// Move the auto-named webm to a friendlier filename.
const rawWebm = await video.path();
const finalWebm = join(OUT_DIR, `demo-${stamp}.webm`);
renameSync(rawWebm, finalWebm);
console.log(`  ✓ saved ${finalWebm}`);

// Optional ffmpeg pass to MP4 (H.264 + AAC silent track) so platforms that
// reject .webm uploads (TikTok, IG) accept it directly.
const finalMp4 = join(OUT_DIR, `demo-${stamp}.mp4`);
const ffmpeg = spawnSync('ffmpeg', [
  '-y', '-i', finalWebm,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-r', '30',
  '-an',                              // no audio yet — voiceover comes later
  '-movflags', '+faststart',
  finalMp4,
], { stdio: 'inherit' });

if (ffmpeg.status === 0 && existsSync(finalMp4)) {
  console.log(`  ✓ encoded ${finalMp4}`);
} else {
  console.warn('  ⚠ ffmpeg not available or failed; .webm is the only output.');
  console.warn('    install: brew install ffmpeg');
}
