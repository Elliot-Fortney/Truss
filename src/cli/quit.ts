/** What Ctrl+C is told when it would throw away a Draft (ADR 0006): the user decides. */
export function quitQuestion(edits: number): string {
  return `You have ${edits} unsaved ${edits === 1 ? 'edit' : 'edits'} in the Draft. Quit and discard ${edits === 1 ? 'it' : 'them'}? [y/N] `;
}

/** True when Truss may quit: nothing is unsaved, or the user said yes. Anything but an explicit yes is a no. */
export async function mayQuit(edits: number, ask: (question: string) => Promise<string>): Promise<boolean> {
  if (edits === 0) return true;
  return /^\s*y(es)?\s*$/i.test(await ask(quitQuestion(edits)));
}
