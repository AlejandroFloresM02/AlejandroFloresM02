// Generates assets/skills.svg: the "Languages and Tools" icon strip, built the same way the
// skill-icons API (https://github.com/LelouchFR/skill-icons, MIT) lays out its grid, so the README
// no longer depends on the hosted go-skill-icons.vercel.app deployment.
//
// Icons are fetched from the skill-icons repo at a pinned commit and nested unchanged into one SVG,
// mirroring generateSvg() in api/index.go (300px cell pitch, 48/256 output scale). Dark variants
// are used for themed icons.
//
// Usage: node scripts/skills.mjs
// Zero dependencies; needs Node 18+.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT_FILE = process.env.OUT_FILE || 'assets/skills.svg';
const REF = '1c213fac65db5decb58aaa7f41db28effcb26df4'; // LelouchFR/skill-icons main, 2026-10-21
const PER_LINE = 13;

// Asset names in display order, resolved from the short ids
// py,ts,js,cpp,c,matlab,postgresql,linux,vscode,ros,opencv,raspberrypi,ubuntu,sklearn,pytorch,
// tensorflow,bash,arduino,cmake,git,figma,obsidian,firebase,docker,aws,claude
const ICONS = [
  'python-dark', 'typescript', 'javascript', 'cpp', 'c', 'matlab-dark', 'postgresql-dark',
  'linux-dark', 'vscode-dark', 'ros-dark', 'opencv-dark', 'raspberrypi-dark', 'ubuntu',
  'scikitlearn-dark', 'pytorch-dark', 'tensorflow-dark', 'bash-dark', 'arduino', 'cmake-dark',
  'git-dark', 'figma-dark', 'obsidian-dark', 'firebase-dark', 'docker', 'aws-dark', 'claude-dark',
];

// Layout constants from api/index.go.
const CELL = 300;
const GAP = 44;
const SCALE = 48 / (CELL - GAP);

async function fetchIcon(name) {
  const url = `https://raw.githubusercontent.com/LelouchFR/skill-icons/${REF}/assets/${name}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
  const svg = (await res.text()).trim();
  if (!svg.includes('viewBox="0 0 256 256"')) throw new Error(`${name}: unexpected viewBox`);
  return svg;
}

// Icons are nested as-is (like the original service), so ids must not collide across icons.
function assertUniqueIds(icons) {
  const owner = new Map();
  icons.forEach((svg, i) => {
    for (const [, id] of svg.matchAll(/\sid="([^"]+)"/g)) {
      if (owner.has(id) && owner.get(id) !== ICONS[i]) {
        throw new Error(`duplicate id "${id}" in ${owner.get(id)} and ${ICONS[i]}`);
      }
      owner.set(id, ICONS[i]);
    }
  });
}

function render(icons) {
  const width = Math.min(PER_LINE, icons.length) * CELL - GAP;
  const height = Math.ceil(icons.length / PER_LINE) * CELL - GAP;
  const cells = icons
    .map((svg, i) => `<g transform="translate(${(i % PER_LINE) * CELL}, ${Math.floor(i / PER_LINE) * CELL})">\n${svg}\n</g>`)
    .join('\n');
  return `<svg width="${Math.trunc(width * SCALE)}" height="${Math.trunc(height * SCALE)}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1">
${cells}
</svg>
`;
}

// ---------------------------------------------------------------------------

const icons = await Promise.all(ICONS.map(fetchIcon));
if (icons.length !== 26) throw new Error(`expected 26 icons, got ${icons.length}`);
assertUniqueIds(icons);

await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, render(icons));
console.log(`${icons.length} icons (${PER_LINE} per line) from skill-icons@${REF.slice(0, 7)} → ${OUT_FILE}`);
