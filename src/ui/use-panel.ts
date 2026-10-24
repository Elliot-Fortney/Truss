import { useEffect, useRef, useState } from 'react';
import type { PanelState } from './property-panel.tsx';
import type { PanelOutcome } from './use-view.ts';

/**
 * The property panel of the Node or Stack `id`, asked for again whenever the Design changes (`version`)
 * so it never shows props the code no longer has. The last answer stays up while the next is awaited.
 */
export function usePanel(
  id: string | undefined,
  version: number | undefined,
  ask: (id: string) => Promise<PanelOutcome>,
): PanelState {
  const [state, setState] = useState<{ id: string; state: PanelState }>();
  const asked = useRef(0);

  useEffect(() => {
    if (id === undefined) return;
    // Answers can arrive out of order, so only the latest question's answer is shown.
    const mine = ++asked.current;
    void ask(id).then((outcome) => {
      if (asked.current === mine)
        setState({
          id,
          state: outcome.ok ? { status: 'ready', panel: outcome.panel } : { status: 'refused', reason: outcome.reason },
        });
    });
  }, [id, version, ask]);

  return id !== undefined && state?.id === id ? state.state : { status: 'loading' };
}
