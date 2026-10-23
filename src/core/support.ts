/**
 * The oldest `aws-cdk-lib` Truss opens: the oldest version the CI corpus covers, about 18 months
 * before the first release (2.191.0 is from 2025-04-23). Bump it on purpose, with the corpus.
 */
export const MIN_CDK_LIB_VERSION = '2.191.0';

/** What Truss reads off the app's installed packages before it loads anything heavy. */
export interface AppVersions {
  /** The installed `aws-cdk-lib`'s version; absent when it isn't installed. */
  cdkLibVersion: string | undefined;
  /** The app depends on CDK v1 (`@aws-cdk/core`). */
  usesCdkV1: boolean;
  /** The `@aws-cdk/cloud-assembly-schema` range the installed `aws-cdk-lib` depends on. */
  schemaRange: string | undefined;
}

export type Support = { ok: true } | { ok: false; message: string };

/** The first number in a version or range: `^55.0.0` and `>=55.2.0` both give 55. */
export function schemaMajorOf(range: string): number | undefined {
  const m = /(\d+)\.\d+\.\d+/.exec(range);
  return m ? Number(m[1]) : undefined;
}

function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function isBelow(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * Decides whether Truss can open the app (ADR 0009). Everything from the minimum `aws-cdk-lib`
 * up opens, except an app whose cloud assembly schema is newer than the one the bundled toolkit-lib reads.
 */
export function checkSupported(app: AppVersions, truss: { schemaMajor: number }): Support {
  if (app.cdkLibVersion === undefined) {
    return {
      ok: false,
      message: app.usesCdkV1
        ? `This app uses CDK v1 (@aws-cdk/core), which Truss doesn't support. Truss needs aws-cdk-lib ${MIN_CDK_LIB_VERSION} or newer.`
        : "aws-cdk-lib isn't installed for this app. Run `npm install` in the app, then start Truss again.",
    };
  }
  if (isBelow(app.cdkLibVersion, MIN_CDK_LIB_VERSION)) {
    return {
      ok: false,
      message: `aws-cdk-lib ${app.cdkLibVersion} is older than the minimum Truss supports, ${MIN_CDK_LIB_VERSION}. Upgrade aws-cdk-lib to open this app.`,
    };
  }
  const major = app.schemaRange === undefined ? undefined : schemaMajorOf(app.schemaRange);
  if (major !== undefined && major > truss.schemaMajor) {
    return {
      ok: false,
      message: `aws-cdk-lib ${app.cdkLibVersion} writes cloud assembly schema ${major}, newer than the schema ${truss.schemaMajor} this Truss reads. Upgrade Truss to open this app.`,
    };
  }
  return { ok: true };
}
