import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAppDir } from './find-app.ts';

describe('findAppDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'truss-find-'));
  mkdirSync(join(root, 'app/lib/deep'), { recursive: true });
  writeFileSync(join(root, 'app/cdk.json'), '{}');

  it('walks up from the working directory to the folder holding cdk.json', () => {
    expect(findAppDir(join(root, 'app/lib/deep'))).toBe(join(root, 'app'));
    expect(findAppDir(join(root, 'app'))).toBe(join(root, 'app'));
  });

  it('returns undefined when there is no cdk.json above', () => {
    expect(findAppDir(root)).toBeUndefined();
  });
});
