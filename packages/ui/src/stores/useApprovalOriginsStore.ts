/**
 * Approval services whose links the chat draws as embedded approval cards
 * (`components/chat/markdown/markdownApprovalCards.ts`). The server reads them
 * from `OPENCHAMBER_APPROVAL_ORIGINS` and answers them on
 * `GET /api/openchamber/approval-origins`; the list changes only with the
 * server's environment, so it is read once per runtime, when the first
 * assistant message asks for it. Nothing here is persisted.
 */
import { z } from 'zod';
import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const approvalOriginsSchema = z.object({ origins: z.array(z.string().min(1)) });

const NO_ORIGINS: readonly string[] = [];

/**
 * The trusted origins in a server answer. A runtime without the route (an
 * older server, the VS Code extension host) answers 404 and trusts none; any
 * other failure throws, so it never reads as "no origins".
 */
export const readApprovalOrigins = async (response: Response): Promise<readonly string[]> => {
  if (response.status === 404) return NO_ORIGINS;
  if (!response.ok) throw new Error(`Approval origins request failed (${response.status})`);
  return approvalOriginsSchema.parse(await response.json()).origins;
};

interface ApprovalOriginsStoreState {
  origins: readonly string[];
  /** Reads the list once per runtime; concurrent callers share the request, and a failed read is tried again by the next caller. */
  ensureLoaded: () => Promise<void>;
}

let loaded = false;
let pending: Promise<void> | null = null;
/** Bumped on every runtime switch; a response from an older runtime is dropped. */
let generation = 0;

export const useApprovalOriginsStore = create<ApprovalOriginsStoreState>()((set) => ({
  origins: NO_ORIGINS,

  ensureLoaded: () => {
    if (loaded) return Promise.resolve();
    if (pending) return pending;
    const requestGeneration = generation;
    pending = (async () => {
      try {
        const origins = await readApprovalOrigins(await runtimeFetch('/api/openchamber/approval-origins'));
        if (requestGeneration !== generation) return;
        loaded = true;
        set({ origins });
      } catch (error) {
        // Without the list no card is drawn; the links stay plain links.
        console.warn('[approval-cards] origins read failed:', error instanceof Error ? error.message : error);
      } finally {
        // A runtime switch has already let go of this request.
        if (requestGeneration === generation) pending = null;
      }
    })();
    return pending;
  },
}));

subscribeRuntimeEndpointChanged(() => {
  generation += 1;
  loaded = false;
  pending = null;
  useApprovalOriginsStore.setState({ origins: NO_ORIGINS });
});
