import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, parseClientMessage } from './protocol.ts';

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

  it('refuses what is not a request', () => {
    expect(parseClientMessage('nope')).toMatchObject({ ok: false });
    expect(parse({ type: 'dance', requestId: '1', id: 'A' })).toMatchObject({ ok: false, requestId: '1' });
    expect(parse({ type: 'search', query: 'a' })).toMatchObject({ ok: false });
  });
});
