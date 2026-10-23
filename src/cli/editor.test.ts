import { describe, expect, it } from 'vitest';
import { editorCommand } from './editor.ts';

const at = { file: '/app/lib/a.ts', line: 12, col: 9 };

describe('editorCommand', () => {
  it('prefers $TRUSS_EDITOR over $VISUAL over $EDITOR', () => {
    const env = { TRUSS_EDITOR: 'cursor', VISUAL: 'subl', EDITOR: 'nano' };
    expect(editorCommand(env, 'linux', at).cmd).toBe('cursor');
    expect(editorCommand({ VISUAL: 'subl', EDITOR: 'nano' }, 'linux', at).cmd).toBe('subl');
    expect(editorCommand({ EDITOR: 'nano' }, 'linux', at).cmd).toBe('nano');
  });

  it('jumps to file:line:col in VS Code and its forks', () => {
    for (const editor of ['code', 'cursor', 'windsurf', 'codium']) {
      expect(editorCommand({ TRUSS_EDITOR: editor }, 'linux', at)).toEqual({ cmd: editor, args: ['--goto', '/app/lib/a.ts:12:9'] });
    }
  });

  it('jumps to file:line:col in Sublime Text, Zed and JetBrains IDEs', () => {
    expect(editorCommand({ TRUSS_EDITOR: 'subl' }, 'linux', at).args).toEqual(['/app/lib/a.ts:12:9']);
    expect(editorCommand({ TRUSS_EDITOR: 'zed' }, 'linux', at).args).toEqual(['/app/lib/a.ts:12:9']);
    expect(editorCommand({ TRUSS_EDITOR: 'idea' }, 'linux', at).args).toEqual(['--line', '12', '--column', '9', '/app/lib/a.ts']);
  });

  it('opens just the file in an editor it does not know', () => {
    expect(editorCommand({ EDITOR: 'someedit' }, 'linux', at)).toEqual({ cmd: 'someedit', args: ['/app/lib/a.ts'] });
  });

  it('knows an editor by its basename and splits extra arguments in the command', () => {
    expect(editorCommand({ TRUSS_EDITOR: '/usr/local/bin/code --reuse-window' }, 'darwin', at)).toEqual({
      cmd: '/usr/local/bin/code',
      args: ['--reuse-window', '--goto', '/app/lib/a.ts:12:9'],
    });
  });

  it('falls back to the platform default when no editor is set', () => {
    expect(editorCommand({}, 'darwin', at)).toEqual({ cmd: 'open', args: ['/app/lib/a.ts'] });
    expect(editorCommand({}, 'linux', at)).toEqual({ cmd: 'xdg-open', args: ['/app/lib/a.ts'] });
    expect(editorCommand({}, 'win32', at)).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', '/app/lib/a.ts'] });
  });

  it('treats a blank variable as unset', () => {
    expect(editorCommand({ TRUSS_EDITOR: '  ', EDITOR: 'nano' }, 'linux', at).cmd).toBe('nano');
  });
});
