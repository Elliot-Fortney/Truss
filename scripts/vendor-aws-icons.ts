// Copies the icons in ICON_FILES, unmodified, out of an unzipped AWS Architecture Icons package:
// `node scripts/vendor-aws-icons.ts ~/Downloads/Icon-package_07312026`. Run it again for each quarterly release.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ICON_FILES } from '../src/core/icons.ts';

const source = process.argv[2];
if (!source) throw new Error('usage: vendor-aws-icons.ts <unzipped-icon-package>');
const target = resolve('assets/aws-architecture-icons');

// Only SVGs of the 48 px service and resource sets, so a name appears once; the PNGs and other sizes are not ours to ship.
const found = new Map<string, string[]>();
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.svg') && !path.includes('__MACOSX')) found.set(entry.name, [...(found.get(entry.name) ?? []), path]);
  }
};
walk(resolve(source));

mkdirSync(target, { recursive: true });
for (const file of readdirSync(target)) if (file.endsWith('.svg')) rmSync(join(target, file));
for (const file of Object.values(ICON_FILES)) {
  const paths = found.get(file) ?? [];
  if (paths.length !== 1) throw new Error(`${file}: expected one file in the package, found ${paths.length}`);
  copyFileSync(paths[0]!, join(target, basename(file)));
}
console.log(`vendored ${Object.keys(ICON_FILES).length} icons into ${target}`);
