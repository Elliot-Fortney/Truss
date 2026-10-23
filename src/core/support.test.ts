import { describe, expect, it } from 'vitest';
import { checkSupported, MIN_CDK_LIB_VERSION, schemaMajorOf } from './support.ts';

const truss = { schemaMajor: 55 };
const app = { cdkLibVersion: '2.274.0', usesCdkV1: false, schemaRange: '^55.0.0' };

describe('checkSupported', () => {
  it('opens an app on a supported aws-cdk-lib', () => {
    expect(checkSupported(app, truss)).toEqual({ ok: true });
  });

  it('opens an app exactly on the minimum', () => {
    expect(checkSupported({ ...app, cdkLibVersion: MIN_CDK_LIB_VERSION, schemaRange: undefined }, truss)).toEqual({ ok: true });
  });

  it('refuses an aws-cdk-lib below the minimum, naming both versions', () => {
    const r = checkSupported({ ...app, cdkLibVersion: '2.150.3' }, truss);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain('2.150.3');
    expect(!r.ok && r.message).toContain(MIN_CDK_LIB_VERSION);
  });

  it('compares versions numerically, not as text', () => {
    expect(checkSupported({ ...app, cdkLibVersion: '2.1000.0', schemaRange: undefined }, truss)).toEqual({ ok: true });
    expect(checkSupported({ ...app, cdkLibVersion: '2.99.0' }, truss).ok).toBe(false);
  });

  it('ignores a prerelease tag', () => {
    expect(checkSupported({ ...app, cdkLibVersion: '2.274.0-alpha.0', schemaRange: undefined }, truss)).toEqual({ ok: true });
  });

  it('refuses CDK v1, which has no aws-cdk-lib', () => {
    const r = checkSupported({ cdkLibVersion: undefined, usesCdkV1: true, schemaRange: undefined }, truss);
    expect(!r.ok && r.message).toMatch(/CDK v1/);
    expect(!r.ok && r.message).toContain(MIN_CDK_LIB_VERSION);
  });

  it('refuses an app with no aws-cdk-lib installed, telling the user to install', () => {
    const r = checkSupported({ cdkLibVersion: undefined, usesCdkV1: false, schemaRange: undefined }, truss);
    expect(!r.ok && r.message).toMatch(/npm install/);
  });

  it('refuses an app whose cloud assembly schema is newer than the one Truss bundles', () => {
    const r = checkSupported({ ...app, schemaRange: '^56.0.0' }, truss);
    expect(!r.ok && r.message).toMatch(/upgrade Truss/i);
    expect(!r.ok && r.message).toContain('56');
    expect(!r.ok && r.message).toContain('55');
  });

  it('opens an app on an older schema', () => {
    expect(checkSupported({ ...app, schemaRange: '^41.2.0' }, truss)).toEqual({ ok: true });
  });

  it('opens an app whose schema range is missing or unreadable', () => {
    expect(checkSupported({ ...app, schemaRange: 'latest' }, truss)).toEqual({ ok: true });
  });
});

describe('schemaMajorOf', () => {
  it('takes the major of the lowest version a range accepts', () => {
    expect(schemaMajorOf('^55.0.0')).toBe(55);
    expect(schemaMajorOf('>=55.2.0')).toBe(55);
    expect(schemaMajorOf('55.1.0')).toBe(55);
    expect(schemaMajorOf('~41.0.1')).toBe(41);
  });

  it('is undefined for a range with no version in it', () => {
    expect(schemaMajorOf('latest')).toBeUndefined();
    expect(schemaMajorOf('*')).toBeUndefined();
  });
});
