/** Dependencies point inward: core <- session <- adapters/ui. `src/cli*` is the composition root (ADR 0007). */
const test = '\\.test\\.tsx?$';

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'The core depends on nothing but itself: no Node built-ins, no packages, no other layer.',
      severity: 'error',
      from: { path: '^src/core/', pathNot: test },
      to: { pathNot: '^src/core/' },
    },
    {
      name: 'session-depends-only-on-core',
      comment: 'The session holds state and calls ports; it never knows an adapter.',
      severity: 'error',
      from: { path: '^src/session/', pathNot: test },
      to: { pathNot: '^src/(core|session)/' },
    },
    {
      name: 'adapters-depend-only-on-core',
      comment: 'An adapter implements a port from the core; adapters do not reach the session, the ui or each other.',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/', pathNot: test },
      to: { path: '^src/(session|ui|cli)' },
    },
    {
      name: 'adapters-do-not-import-each-other',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/', pathNot: test },
      to: { path: '^src/adapters/([^/]+)/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'ui-sees-only-the-core-view',
      comment: 'The browser is a thin view: it may import core types, never the session or an adapter.',
      severity: 'error',
      from: { path: '^src/ui/', pathNot: test },
      to: { path: '^src/(session|adapters|cli)' },
    },
    {
      name: 'ui-has-no-node',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'typescript-only-in-source',
      comment: 'Only the Source adapter imports typescript, so a TS 7 swap stays local (ADR 0007).',
      severity: 'error',
      from: { pathNot: '^src/adapters/source/' },
      to: { path: '(^|/)node_modules/(typescript|@typescript/[^/]+)/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
