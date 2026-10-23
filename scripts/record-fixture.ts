// Re-records test/fixtures/<name>/assembly.json from a real synth: `node scripts/record-fixture.ts straight-line`.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ToolkitSynth } from '../src/adapters/synth/toolkit-synth.ts';

const name = process.argv[2];
if (!name) throw new Error('usage: record-fixture.ts <fixture-name>');
const appDir = resolve('test/fixtures', name);

const result = await new ToolkitSynth().synth(appDir);
if (!result.ok) throw new Error(result.error.message + '\n' + (result.error.output ?? ''));
writeFileSync(join(appDir, 'assembly.json'), JSON.stringify(result.assembly, null, 2) + '\n');
console.log(`recorded ${name}/assembly.json`);
