import { basename } from 'node:path';
import type { EditorRequest } from '../core/assembly.ts';

export type EditorTarget = EditorRequest;

type Goto = (file: string, line: number, col: number) => string[];
const colonSuffix: Goto = (file, line, col) => [`${file}:${line}:${col}`];
const vscode: Goto = (file, line, col) => ['--goto', `${file}:${line}:${col}`];
const jetbrains: Goto = (file, line, col) => ['--line', String(line), '--column', String(col), file];

const KNOWN: Record<string, Goto> = {
  code: vscode,
  'code-insiders': vscode,
  cursor: vscode,
  windsurf: vscode,
  codium: vscode,
  subl: colonSuffix,
  zed: colonSuffix,
  idea: jetbrains,
  webstorm: jetbrains,
};

/** The command that opens `target` in the user's editor: `$TRUSS_EDITOR`, `$VISUAL`, `$EDITOR`, then the platform default. */
export function editorCommand(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  target: EditorTarget,
): { cmd: string; args: string[] } {
  const configured = [env.TRUSS_EDITOR, env.VISUAL, env.EDITOR].find((v) => v?.trim());
  if (configured) {
    const [cmd = '', ...extra] = configured.trim().split(/\s+/);
    const goto = KNOWN[basename(cmd)];
    return { cmd, args: [...extra, ...(goto ? goto(target.file, target.line ?? 1, target.col ?? 1) : [target.file])] };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [target.file] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', target.file] };
  return { cmd: 'xdg-open', args: [target.file] };
}
