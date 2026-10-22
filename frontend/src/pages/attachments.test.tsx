import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Conversation, Message } from '@linka/shared';
import { App } from '../App';
import { clearAttachmentUrls } from '../services/attachmentUrls';
import { mockApi, type ApiCall } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { CONVERSATION_ID, makeConversation, makeMessage } from '../test/messages';
import { renderWithAuth, testProfile } from '../test/render';
import { TEST_USER_ID } from '../test/supabaseMock';
import { FakeXhr, installUploadFakes, testFile } from '../test/xhr';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

afterEach(() => clearAttachmentUrls());

const conversationPath = `/api/conversations/${CONVERSATION_ID}`;
const messagesPath = `${conversationPath}/messages`;
const uploadsPath = `${conversationPath}/attachments`;

interface Upload {
  id: string;
  clientId: string;
  fileName: string;
  contentType: Attachment['contentType'];
  sizeBytes: number;
  status: 'pending' | 'ready';
}

interface Backend {
  conversations?: Conversation[];
  messages?: Message[];
  /** Answer for POST .../complete; default: ready. */
  onComplete?: (upload: Upload) => Response | undefined;
  /** Which attachment ids the URL endpoint may sign; default: all. */
  visible?: (id: string) => boolean;
}

const asAttachment = (u: Upload): Attachment => ({ id: u.id, fileName: u.fileName, contentType: u.contentType, sizeBytes: u.sizeBytes });
const asUpload = (u: Upload) => ({ ...asAttachment(u), conversationId: CONVERSATION_ID, status: u.status });

/** The fake API: chat basics plus the upload lifecycle (start, complete, cancel, URLs, send). */
function backend({ conversations = [makeConversation()], messages = [], onComplete, visible = () => true }: Backend = {}) {
  const uploads = new Map<string, Upload>();
  const api = mockApi((call: ApiCall) => {
    if (call.path === '/api/users/me') return jsonResponse(testProfile());
    if (call.method === 'GET' && call.path === '/api/conversations') return jsonResponse({ conversations });
    if (call.method === 'GET' && call.path === conversationPath) return jsonResponse(conversations[0]);
    if (call.method === 'GET' && call.path === messagesPath) return jsonResponse({ messages, nextCursor: null });

    if (call.method === 'POST' && call.path === uploadsPath) {
      const body = call.body as Omit<Upload, 'id' | 'status'>;
      let upload = [...uploads.values()].find((u) => u.clientId === body.clientId);
      const created = !upload;
      upload ??= { ...body, id: crypto.randomUUID(), status: 'pending' };
      uploads.set(upload.id, upload);
      return jsonResponse(
        {
          attachment: asUpload(upload),
          upload: upload.status === 'pending' ? { url: `https://storage.test/upload/${upload.id}?token=t`, expiresAt: new Date(Date.now() + 7_200_000).toISOString() } : null,
        },
        created ? 201 : 200,
      );
    }
    const complete = call.path.match(/^\/api\/attachments\/([^/]+)\/complete$/);
    if (call.method === 'POST' && complete) {
      const upload = uploads.get(complete[1]!)!;
      const custom = onComplete?.(upload);
      if (custom) return custom;
      upload.status = 'ready';
      return jsonResponse(asUpload(upload));
    }
    if (call.method === 'DELETE' && call.path.startsWith('/api/attachments/')) return new Response(null, { status: 204 });
    if (call.method === 'POST' && call.path === '/api/attachments/urls') {
      const ids = (call.body as { attachmentIds: string[] }).attachmentIds;
      return jsonResponse({
        urls: ids.filter(visible).map((id) => ({ id, url: `https://storage.test/sign/${id}?token=s`, expiresAt: new Date(Date.now() + 600_000).toISOString() })),
      });
    }
    if (call.method === 'POST' && call.path === messagesPath) {
      const body = call.body as { content?: string; clientId: string; attachmentIds?: string[] };
      const attachments = (body.attachmentIds ?? []).map((id) => asAttachment(uploads.get(id)!));
      return jsonResponse(
        makeMessage({ senderId: TEST_USER_ID, clientId: body.clientId, content: body.content ?? null, type: attachments.length ? 'attachment' : 'text', attachments }),
        201,
      );
    }
    return undefined;
  });
  return { ...api, uploads };
}

async function openConversation(options: Backend = {}) {
  const fakes = installUploadFakes();
  const api = backend(options);
  const view = renderWithAuth(<App />, { path: `/conversations/${CONVERSATION_ID}` });
  await screen.findByRole('textbox', { name: 'Message' });
  await screen.findByRole('log', { name: 'Messages' }).catch(() => undefined);
  return { api, fakes, view };
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const pick = (...files: File[]) => fireEvent.change(fileInput(), { target: { files } });
const sendButton = () => screen.getByRole('button', { name: 'Send' });
const attachmentsList = () => screen.getByRole('list', { name: 'Attachments' });

/** Waits for the upload's PUT, then finishes it. */
async function finishUpload(status = 200) {
  await waitFor(() => expect(FakeXhr.instances.length).toBeGreaterThan(0));
  const xhr = FakeXhr.instances.at(-1)!;
  act(() => {
    xhr.progress(1024, 2048);
  });
  act(() => xhr.respond(status));
  return xhr;
}

describe('uploading attachments', () => {
  it('uploads a picked image straight to its signed URL, with progress, then sends it with a caption', async () => {
    const { api } = await openConversation();
    const file = testFile('beach.png', 'image/png');

    pick(file);

    // Started with the file's details and a fresh clientId; never a path.
    await waitFor(() => expect(api.callsTo('POST', uploadsPath)).toHaveLength(1));
    const start = api.callsTo('POST', uploadsPath)[0]!.body as Record<string, unknown>;
    expect(start).toEqual({ clientId: expect.stringMatching(/^[0-9a-f-]{36}$/), fileName: 'beach.png', contentType: 'image/png', sizeBytes: 2048 });

    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toMatch(/^https:\/\/storage\.test\/upload\//);
    expect(xhr.headers.get('content-type')).toBe('image/png');
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText('Uploading… you can send once files are ready.')).toBeInTheDocument();

    act(() => xhr.progress(1024, 2048));
    expect(screen.getByRole('progressbar', { name: 'Uploading beach.png' })).toHaveAttribute('aria-valuenow', '50');

    act(() => xhr.respond(200));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const [upload] = [...api.uploads.values()];
    expect(api.callsTo('POST', `/api/attachments/${upload!.id}/complete`)).toHaveLength(1);

    const input = screen.getByRole('textbox', { name: 'Message' });
    expect(input).toHaveAttribute('placeholder', 'Add a caption');
    fireEvent.change(input, { target: { value: 'Look at this' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.callsTo('POST', messagesPath)).toHaveLength(1));
    expect(api.callsTo('POST', messagesPath)[0]!.body).toEqual({
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      content: 'Look at this',
      attachmentIds: [upload!.id],
    });
    // The composer is cleared and the sent attachment is not deleted.
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    // The confirmed message shows the image through a signed URL.
    const log = await screen.findByRole('log', { name: 'Messages' });
    const image = await within(log).findByRole('img', { name: 'beach.png' });
    expect(image).toHaveAttribute('src', `https://storage.test/sign/${upload!.id}?token=s`);
    expect(within(log).getByText('Look at this')).toBeInTheDocument();
  });

  it('sends attachments without text', async () => {
    const { api } = await openConversation();
    pick(testFile('plan.pdf', 'application/pdf'));
    await finishUpload();
    await waitFor(() => expect(sendButton()).toBeEnabled());

    fireEvent.click(sendButton());

    await waitFor(() => expect(api.callsTo('POST', messagesPath)).toHaveLength(1));
    const body = api.callsTo('POST', messagesPath)[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('content');
    expect(body.attachmentIds).toHaveLength(1);
  });

  it('does not send text while a file is still uploading or failed, by button or Enter', async () => {
    const { api } = await openConversation();
    pick(testFile('beach.png', 'image/png'));
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Caption' } });

    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });

    act(() => FakeXhr.instances[0]!.respond(500));
    await within(attachmentsList()).findByText('The upload did not go through. Try again.');
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.callsTo('POST', messagesPath)).toEqual([]);

    // Removing the failed file sends the text on its own.
    fireEvent.click(within(attachmentsList()).getByRole('button', { name: 'Remove beach.png' }));
    expect(sendButton()).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.callsTo('POST', messagesPath)).toHaveLength(1));
    expect(api.callsTo('POST', messagesPath)[0]!.body).not.toHaveProperty('attachmentIds');
  });

  it('refuses unsupported, empty and oversized files before uploading anything', async () => {
    const { api } = await openConversation();

    pick(testFile('logo.svg', 'image/svg+xml'), testFile('empty.txt', 'text/plain', 0), testFile('huge.png', 'image/png', 11 * 1024 * 1024));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'logo.svg: This type of file is not supported. empty.txt: This file is empty. huge.png: This file is too large (max 10 MB).',
    );
    expect(api.callsTo('POST', uploadsPath)).toEqual([]);
    expect(FakeXhr.instances).toEqual([]);
  });

  it('limits a message to 10 attachments', async () => {
    const { api } = await openConversation();
    pick(...Array.from({ length: 12 }, (_, i) => testFile(`photo-${i}.png`, 'image/png')));

    expect(await screen.findByRole('alert')).toHaveTextContent('You can attach up to 10 files to a message.');
    await waitFor(() => expect(api.callsTo('POST', uploadsPath)).toHaveLength(10));
    expect(within(attachmentsList()).getAllByRole('listitem')).toHaveLength(10);
  });

  it('cancelling stops the upload and deletes it on the server', async () => {
    const { api, fakes } = await openConversation();
    pick(testFile('beach.png', 'image/png'));
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const [upload] = [...api.uploads.values()];

    fireEvent.click(within(attachmentsList()).getByRole('button', { name: 'Cancel beach.png' }));

    expect(FakeXhr.instances[0]!.aborted).toBe(true);
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('DELETE', `/api/attachments/${upload!.id}`)).toHaveLength(1));
    expect(fakes.revoked).toEqual(fakes.created); // the local preview is released
  });

  it('a failed upload can be retried and reuses the same clientId', async () => {
    const { api } = await openConversation();
    pick(testFile('beach.png', 'image/png'));
    await finishUpload(500);

    const chip = attachmentsList();
    expect(await within(chip).findByText('The upload did not go through. Try again.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText('Remove or retry the files that did not upload.')).toBeInTheDocument();

    fireEvent.click(within(chip).getByRole('button', { name: 'Retry beach.png' }));
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    act(() => FakeXhr.instances[1]!.respond(200));
    await waitFor(() => expect(sendButton()).toBeEnabled());

    const starts = api.callsTo('POST', uploadsPath).map((c) => (c.body as { clientId: string }).clientId);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBe(starts[0]);
    expect(api.uploads.size).toBe(1);
  });

  it('shows a rejected file (content does not match its type) without offering a retry', async () => {
    await openConversation({
      onComplete: () =>
        jsonResponse({ error: { code: 'UPLOAD_REJECTED', message: 'The file content does not match its type.' } }, 422),
    });
    pick(testFile('fake.png', 'image/png'));
    await finishUpload();

    const chip = attachmentsList();
    expect(await within(chip).findByText('The file content does not match its type.')).toBeInTheDocument();
    expect(within(chip).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove fake.png' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('leaving the conversation deletes unsent uploads', async () => {
    const { api, view } = await openConversation();
    pick(testFile('plan.pdf', 'application/pdf'));
    await finishUpload();
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const [upload] = [...api.uploads.values()];

    view.unmount();

    await waitFor(() => expect(api.callsTo('DELETE', `/api/attachments/${upload!.id}`)).toHaveLength(1));
  });
});

describe('showing attachments', () => {
  const image = { id: '3f9a1c2e-4b6d-4e8f-9a1b-2c3d4e5f6a7b', fileName: 'sunset.jpg', contentType: 'image/jpeg' as const, sizeBytes: 120_000 };
  const pdf = { id: '7d2e4f6a-8b0c-4d1e-9f2a-3b4c5d6e7f80', fileName: 'Trip plan.pdf', contentType: 'application/pdf' as const, sizeBytes: 1_500_000 };

  it('fetches every URL a page needs in one request and renders images and files', async () => {
    const { api } = await openConversation({
      messages: [makeMessage({ type: 'attachment', content: null, attachments: [image] }), makeMessage({ type: 'attachment', content: 'The plan', attachments: [pdf] })],
    });
    const log = screen.getByRole('log', { name: 'Messages' });

    expect(await within(log).findByRole('img', { name: 'sunset.jpg' })).toHaveAttribute('src', `https://storage.test/sign/${image.id}?token=s`);
    const download = await within(log).findByRole('link', { name: 'Download Trip plan.pdf' });
    expect(download).toHaveAttribute('href', `https://storage.test/sign/${pdf.id}?token=s&download=Trip%20plan.pdf`);
    expect(within(log).getByText('1.4 MB')).toBeInTheDocument();
    expect(within(log).getByText('The plan')).toBeInTheDocument();

    const urlCalls = api.callsTo('POST', '/api/attachments/urls');
    expect(urlCalls).toHaveLength(1);
    expect((urlCalls[0]!.body as { attachmentIds: string[] }).attachmentIds.sort()).toEqual([image.id, pdf.id].sort());
  });

  it('says when an attachment is not available', async () => {
    await openConversation({
      messages: [makeMessage({ type: 'attachment', content: null, attachments: [image] })],
      visible: () => false,
    });
    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
  });

  it('retries a broken image once with a fresh URL, then offers a manual retry', async () => {
    const { api } = await openConversation({ messages: [makeMessage({ type: 'attachment', content: null, attachments: [image] })] });
    const log = screen.getByRole('log', { name: 'Messages' });

    fireEvent.error(await within(log).findByRole('img', { name: 'sunset.jpg' }));
    await waitFor(() => expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(2));
    fireEvent.error(await within(log).findByRole('img', { name: 'sunset.jpg' }));

    expect(await within(log).findByText('Could not load image')).toBeInTheDocument();
    fireEvent.click(within(log).getByRole('button', { name: 'Retry' }));
    expect(await within(log).findByRole('img', { name: 'sunset.jpg' })).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/attachments/urls')).toHaveLength(3);
  });

  it('previews an attachment-only message in the chat list', async () => {
    await openConversation({
      conversations: [makeConversation({ lastMessage: makeMessage({ senderId: TEST_USER_ID, type: 'attachment', content: null, attachments: [image, { ...image, id: crypto.randomUUID() }] }) })],
    });
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByText('You: 2 photos')).toBeInTheDocument();
  });
});
