import { describe, expect, it } from 'vitest';
import { readFixtureAssembly, readFixtureFiles } from '../../../test/support/fixture.ts';
import { TsSource } from './ts-source.ts';

describe('TsSource.analyse on the straight-line fixture', () => {
  const facts = new TsSource().analyse(readFixtureFiles('straight-line'), readFixtureAssembly('straight-line'));

  it('gives each construct its file, span, class and literal ID', () => {
    expect(facts.nodes['ShopStack/Uploads']).toEqual({
      span: { file: 'lib/shop-stack.ts', start: { line: 11, col: 5 }, end: { line: 13, col: 7 } },
      className: 's3.Bucket',
      literalId: 'Uploads',
      pathsOnSpan: 1,
    });
    expect(facts.nodes['ShopStack/Orders']).toMatchObject({ className: 'sqs.Queue', literalId: 'Orders' });
    expect(facts.nodes['ShopStack/Catalog']).toMatchObject({ className: 'dynamodb.Table', literalId: 'Catalog' });
  });

  it('gives the stack its own facts at the call in bin/', () => {
    expect(facts.nodes['ShopStack']).toMatchObject({
      span: { file: 'bin/app.ts', start: { line: 5, col: 1 } },
      className: 'ShopStack',
      literalId: 'ShopStack',
      pathsOnSpan: 1,
    });
  });

  it('has no facts for resources the app did not write', () => {
    expect(Object.keys(facts.nodes).sort()).toEqual([
      'ShopStack',
      'ShopStack/Catalog',
      'ShopStack/Orders',
      'ShopStack/Uploads',
    ]);
  });
});

describe('TsSource.analyse on a stack with a single construct', () => {
  it('still gives that construct its own Node, not the stack', () => {
    const assembly = readFixtureAssembly('straight-line');
    const only = assembly.tree.children[0]!;
    only.children = only.children.filter((c) => c.id === 'Uploads');
    for (const path of ['ShopStack', 'ShopStack/Orders/Resource', 'ShopStack/Catalog/Resource']) delete assembly.creation[path];
    const facts = new TsSource().analyse(readFixtureFiles('straight-line'), assembly);
    expect(Object.keys(facts.nodes)).toEqual(['ShopStack/Uploads']);
  });
});
