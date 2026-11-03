import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { attachApprovalCards } from './markdownApprovalCards';

// Frames load through this interceptor, never the network: a loaded frame has
// the real `contentWindow` the height messages are checked against.
const win = new Window({
  url: 'https://openchamber.test/',
  settings: {
    fetch: {
      interceptor: {
        beforeAsyncRequest: async ({ window }) => new window.Response('<p>card</p>', { headers: { 'Content-Type': 'text/html' } }),
      },
    },
  },
});
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  HTMLParagraphElement: win.HTMLParagraphElement,
  HTMLIFrameElement: win.HTMLIFrameElement,
  MessageEvent: win.MessageEvent,
  MutationObserver: win.MutationObserver,
});

const TRUSTED = 'https://approvals.example';
const link = (href: string, text = href): string => `<a href="${href}" class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;

const detachers: (() => void)[] = [];

const mount = (html: string, origins: readonly string[] = [TRUSTED]) => {
  const container = document.createElement('div');
  container.innerHTML = `<div data-markdown-content>${html}</div>`;
  document.body.appendChild(container);
  detachers.push(attachApprovalCards(container, origins));
  return container;
};

const settle = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const heightMessage = (origin: string, source: MessageEventSource | null | undefined, height: number | string) => {
  window.dispatchEvent(new MessageEvent('message', { origin, source: source ?? null, data: { type: 'herald-card-height', height } }));
};

afterEach(() => {
  while (detachers.length > 0) detachers.pop()?.();
  document.body.innerHTML = '';
});

describe('approval cards', () => {
  test('a trusted approval link on a line of its own becomes one card', () => {
    const container = mount(`<p>Before</p><p>${link(`${TRUSTED}/a/ABC123`)}</p><p>After</p>`);
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.getAttribute('src')).toBe(`${TRUSTED}/a/ABC123?view=card`);
    expect(frame?.getAttribute('allow')).toBe('publickey-credentials-get *');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.style.height).toBe('360px');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
  });

  test('the same link inside a sentence stays a link', () => {
    const container = mount(`<p>Approve it here: ${link(`${TRUSTED}/a/ABC123`)} please</p>`);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a')).not.toBeNull();
  });

  test('links to other origins, lookalikes included, stay links', () => {
    const container = mount([
      `<p>${link('https://other.example/a/ABC123')}</p>`,
      `<p>${link('https://approvals.example.evil.test/a/ABC123')}</p>`,
      `<p>${link('http://approvals.example/a/ABC123')}</p>`,
    ].join(''));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(3);
  });

  test('a trusted origin with any other path stays a link', () => {
    const container = mount([
      `<p>${link(`${TRUSTED}/list`)}</p>`,
      `<p>${link(`${TRUSTED}/a/ABC123/cancel`)}</p>`,
      `<p>${link(`${TRUSTED}/a/`)}</p>`,
    ].join(''));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(3);
  });

  test('a height message from the card resizes it, clamped; any other is ignored', async () => {
    const container = mount(`<p>${link(`${TRUSTED}/a/ABC123`)}</p><p>${link(`${TRUSTED}/a/DEF456`)}</p>`);
    await settle();
    const [frame, otherFrame] = Array.from(container.querySelectorAll('iframe'));
    expect(frame?.contentWindow).not.toBeNull();

    heightMessage(TRUSTED, frame?.contentWindow, 412);
    expect(frame?.style.height).toBe('412px');
    expect(otherFrame?.style.height).toBe('360px');

    heightMessage('https://other.example', frame?.contentWindow, 500);
    heightMessage(TRUSTED, window, 500);
    heightMessage(TRUSTED, null, 500);
    heightMessage(TRUSTED, frame?.contentWindow, 'tall');
    expect(frame?.style.height).toBe('412px');

    heightMessage(TRUSTED, frame?.contentWindow, 5000);
    expect(frame?.style.height).toBe('900px');
    heightMessage(TRUSTED, frame?.contentWindow, 10);
    expect(frame?.style.height).toBe('120px');
  });

  test('links that arrive later become cards, never two for one link', async () => {
    const container = mount('<p>Working on it</p>');
    const content = container.querySelector('[data-markdown-content]');
    content?.insertAdjacentHTML('beforeend', `<p>${link(`${TRUSTED}/a/ABC123`)}</p>`);
    await settle();
    content?.insertAdjacentHTML('beforeend', '<p>More text</p>');
    await settle();
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });

  test('with no trusted origins nothing changes', () => {
    const html = `<p>${link(`${TRUSTED}/a/ABC123`)}</p>`;
    const container = mount(html, []);
    expect(container.querySelector('[data-markdown-content]')?.innerHTML).toBe(html);
  });

  test('after cleanup a height message does nothing', async () => {
    const container = mount(`<p>${link(`${TRUSTED}/a/ABC123`)}</p>`);
    await settle();
    const frame = container.querySelector('iframe');
    detachers.pop()?.();
    heightMessage(TRUSTED, frame?.contentWindow, 412);
    expect(frame?.style.height).toBe('360px');
  });
});
