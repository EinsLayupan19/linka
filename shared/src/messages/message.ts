import { z } from 'zod';

export const MESSAGE_MAX_LENGTH = 4000;

/** Only text for now; new kinds (e.g. attachment-only, system notices) are added here. */
export const MESSAGE_TYPES = ['text'] as const;
export const messageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const messageContentSchema = z
  .string()
  .trim()
  .min(1, 'Write a message.')
  .max(MESSAGE_MAX_LENGTH, `Messages can be at most ${MESSAGE_MAX_LENGTH} characters.`);

/** A new text message. The sender is always the signed-in user, so it never appears here. */
export const createMessageSchema = z.strictObject({
  content: messageContentSchema,
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  /** null when the sender's account was deleted. */
  senderId: z.uuid().nullable(),
  type: messageTypeSchema,
  content: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type Message = z.infer<typeof messageSchema>;
