// Approval links as cards. An agent that needs a person's approval prints the
// approval service's link on a line of its own; when the service's origin is
// one the server trusts (`OPENCHAMBER_APPROVAL_ORIGINS`), the link is replaced
// by the service's own compact page (`/a/<id>?view=card`) in a frame, so the
// person approves, passkey included, without leaving the chat. The service
// draws the card; this module only finds the link and sizes the frame.
//
// The frame is built here, never from Markdown: the renderer's sanitizer keeps
// refusing iframes, and only links whose origin is exactly trusted qualify.

import { z } from 'zod';

const APPROVAL_PATH_RE = /^\/a\/[A-Za-z0-9]+$/;
const CARD_ATTR = 'data-openchamber-approval-card';
const HEIGHT_MESSAGE_TYPE = 'herald-card-height';
const INITIAL_HEIGHT_PX = 360;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 900;
const FRAME_CLASS = 'block w-full my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/10';

/** The card address for a link that is a trusted approval, or null. */
const cardSource = (link: HTMLAnchorElement, trustedOrigins: readonly string[]): string | null => {
  let url: URL;
  try {
    url = new URL(link.getAttribute('href') ?? '');
  } catch {
    return null;
  }
  if (!trustedOrigins.includes(url.origin) || !APPROVAL_PATH_RE.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}?view=card`;
};

/** The paragraph a link fills on its own, or null when anything else shares it. */
const ownParagraph = (link: HTMLAnchorElement): HTMLParagraphElement | null => {
  const paragraph = link.parentElement;
  if (!(paragraph instanceof HTMLParagraphElement)) return null;
  const alone = Array.from(paragraph.childNodes).every((node) => node === link || (node.nodeType === node.TEXT_NODE && !node.textContent?.trim()));
  return alone ? paragraph : null;
};

const createCardFrame = (document: Document, source: string): HTMLIFrameElement => {
  const frame = document.createElement('iframe');
  frame.setAttribute(CARD_ATTR, 'true');
  frame.src = source;
  // The card asks for the person's passkey; nothing else is delegated.
  frame.setAttribute('allow', 'publickey-credentials-get *');
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'Approval request';
  frame.className = FRAME_CLASS;
  frame.style.height = `${INITIAL_HEIGHT_PX}px`;
  return frame;
};

const replaceApprovalLinks = (container: HTMLElement, trustedOrigins: readonly string[]): void => {
  for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>('a.external-link'))) {
    const source = cardSource(link, trustedOrigins);
    const paragraph = source ? ownParagraph(link) : null;
    if (!source || !paragraph) continue;
    paragraph.replaceWith(createCardFrame(container.ownerDocument, source));
  }
};

const heightMessageSchema = z.object({ type: z.literal(HEIGHT_MESSAGE_TYPE), height: z.number().finite() });

/**
 * Turns trusted approval links in `container` into cards, now and as the
 * message's content changes. Returns the cleanup; cards already drawn stay.
 */
export const attachApprovalCards = (container: HTMLElement, trustedOrigins: readonly string[]): (() => void) => {
  if (trustedOrigins.length === 0) return () => {};
  const view = container.ownerDocument.defaultView;
  if (!view) return () => {};

  // Only a card's own window, from a trusted origin, may size its frame.
  const handleMessage = (event: MessageEvent) => {
    if (!trustedOrigins.includes(event.origin) || !event.source) return;
    const message = heightMessageSchema.safeParse(event.data);
    if (!message.success) return;
    const frame = Array.from(container.querySelectorAll<HTMLIFrameElement>(`iframe[${CARD_ATTR}]`))
      .find((candidate) => candidate.contentWindow === event.source);
    if (!frame) return;
    const height = Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, Math.ceil(message.data.height)));
    frame.style.height = `${height}px`;
  };

  replaceApprovalLinks(container, trustedOrigins);
  const mutations = new MutationObserver(() => replaceApprovalLinks(container, trustedOrigins));
  mutations.observe(container, { childList: true, subtree: true });
  view.addEventListener('message', handleMessage);
  return () => {
    mutations.disconnect();
    view.removeEventListener('message', handleMessage);
  };
};
