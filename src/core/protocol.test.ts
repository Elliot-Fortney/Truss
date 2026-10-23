import { describe, expect, it } from 'vitest';
import { MAX_PROP_DEPTH, MAX_QUERY_LENGTH, MAX_STRING_VALUE_LENGTH, parseClientMessage } from './protocol.ts';

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));

describe('parseClientMessage', () => {
  it('reads a move and a note, which name a construct path', () => {
    expect(parse({ type: 'move', requestId: '1', id: 'A/B', x: 1, y: 2 })).toEqual({ ok: true, message: { type: 'move', requestId: '1', id: 'A/B', x: 1, y: 2 } });
    expect(parse({ type: 'note', requestId: '2', id: 'A/B', note: 'hi' })).toEqual({ ok: true, message: { type: 'note', requestId: '2', id: 'A/B', note: 'hi' } });
  });

  it('refuses an edit without a construct path, saying which request it was', () => {
    expect(parse({ type: 'move', requestId: '1', x: 1, y: 2 })).toMatchObject({ ok: false, requestId: '1' });
  });

  describe('search', () => {
    it('needs no construct path, and may ask for everything with an empty query', () => {
      expect(parse({ type: 'search', requestId: '3', query: 'queue' })).toEqual({ ok: true, message: { type: 'search', requestId: '3', query: 'queue' } });
      expect(parse({ type: 'search', requestId: '3', query: '' })).toMatchObject({ ok: true });
    });

    it('refuses a query that is not text or is absurdly long', () => {
      expect(parse({ type: 'search', requestId: '3' })).toMatchObject({ ok: false, requestId: '3' });
      expect(parse({ type: 'search', requestId: '3', query: 7 })).toMatchObject({ ok: false });
      expect(parse({ type: 'search', requestId: '3', query: 'x'.repeat(MAX_QUERY_LENGTH + 1) })).toMatchObject({ ok: false });
      expect(parse({ type: 'search', requestId: '3', query: 'x'.repeat(MAX_QUERY_LENGTH) })).toMatchObject({ ok: true });
    });
  });

  describe('the Draft', () => {
    it('reads undo, redo, save and discard, which name nothing', () => {
      for (const type of ['undo', 'redo', 'save', 'discard']) {
        expect(parse({ type, requestId: '1' })).toEqual({ ok: true, message: { type, requestId: '1' } });
      }
    });

    it('reads a setProp of each kind of value', () => {
      const set = (value: unknown, prop: unknown = ['versioned']) => parse({ type: 'setProp', requestId: '4', id: 'A/B', prop, value });
      for (const value of [
        { kind: 'string', value: 'hi' },
        { kind: 'number', value: 3 },
        { kind: 'boolean', value: false },
        { kind: 'enum', type: 'aws-cdk-lib.aws_s3.BucketEncryption', member: 'KMS_MANAGED' },
        { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' },
        { kind: 'duration', unit: 'seconds', amount: 30 },
        { kind: 'size', unit: 'mebibytes', amount: 512 },
      ]) {
        expect(set(value), JSON.stringify(value)).toEqual({ ok: true, message: { type: 'setProp', requestId: '4', id: 'A/B', prop: ['versioned'], value } });
      }
      expect(set({ kind: 'boolean', value: true }, ['partitionKey', 'name'])).toMatchObject({ ok: true, message: { prop: ['partitionKey', 'name'] } });
    });

    it('refuses a value that could be read as code or is not a value Truss writes', () => {
      const bad = (value: unknown, prop: unknown = ['x']) => parse({ type: 'setProp', requestId: '4', id: 'A/B', prop, value });
      expect(bad({ kind: 'string', value: 5 })).toMatchObject({ ok: false, requestId: '4' });
      expect(bad({ kind: 'string', value: 'x'.repeat(MAX_STRING_VALUE_LENGTH + 1) })).toMatchObject({ ok: false });
      expect(bad({ kind: 'number', value: Infinity })).toMatchObject({ ok: false });
      expect(bad({ kind: 'number', value: '3' })).toMatchObject({ ok: false });
      expect(bad({ kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY; evil()' })).toMatchObject({ ok: false });
      expect(bad({ kind: 'enum', type: 'evil-lib.Thing', member: 'A' })).toMatchObject({ ok: false });
      expect(bad({ kind: 'duration', unit: 'fortnights', amount: 1 })).toMatchObject({ ok: false });
      expect(bad({ kind: 'size', unit: 'seconds', amount: 1 })).toMatchObject({ ok: false });
      expect(bad({ kind: 'duration', unit: 'seconds', amount: -1 })).toMatchObject({ ok: false });
      expect(bad({ kind: 'expression', text: 'process.exit()' })).toMatchObject({ ok: false });
      expect(bad(undefined)).toMatchObject({ ok: false });
    });

    it('refuses a prop that is not a list of plain names', () => {
      const value = { kind: 'boolean', value: true };
      const set = (prop: unknown) => parse({ type: 'setProp', requestId: '4', id: 'A/B', prop, value });
      expect(set([])).toMatchObject({ ok: false });
      expect(set('versioned')).toMatchObject({ ok: false });
      expect(set(['a b'])).toMatchObject({ ok: false });
      expect(set(['a: 1, b'])).toMatchObject({ ok: false });
      expect(set(Array.from({ length: MAX_PROP_DEPTH + 1 }, () => 'a'))).toMatchObject({ ok: false });
      expect(parse({ type: 'setProp', requestId: '4', prop: ['a'], value })).toMatchObject({ ok: false });
    });
  });

  it('refuses what is not a request', () => {
    expect(parseClientMessage('nope')).toMatchObject({ ok: false });
    expect(parse({ type: 'dance', requestId: '1', id: 'A' })).toMatchObject({ ok: false, requestId: '1' });
    expect(parse({ type: 'search', query: 'a' })).toMatchObject({ ok: false });
  });
});
