import { describe, expect, it } from 'vitest';
import { namesShownAt } from './zoom.ts';

describe('namesShownAt', () => {
  it('shows Node names once the canvas is zoomed in far enough to read them', () => {
    expect(namesShownAt(1)).toBe(true);
    expect(namesShownAt(0.6)).toBe(true);
  });

  it('leaves just the icons when zoomed out', () => {
    expect(namesShownAt(0.59)).toBe(false);
    expect(namesShownAt(0.1)).toBe(false);
  });
});
