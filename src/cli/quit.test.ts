import { describe, expect, it, vi } from 'vitest';
import { mayQuit, quitQuestion } from './quit.ts';

describe('mayQuit', () => {
  it('quits without asking when nothing is unsaved', async () => {
    const ask = vi.fn(async () => 'n');
    expect(await mayQuit(0, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(['y', 'Y', 'yes', ' YES\n'])('quits when the answer is %j', async (answer) => {
    expect(await mayQuit(2, async () => answer)).toBe(true);
  });

  it.each(['', 'n', 'no', 'maybe', 'yep'])('stays when the answer is %j', async (answer) => {
    expect(await mayQuit(2, async () => answer)).toBe(false);
  });

  it('asks how many edits would be lost', () => {
    expect(quitQuestion(1)).toContain('1 unsaved edit in the Draft');
    expect(quitQuestion(3)).toContain('3 unsaved edits');
  });
});
