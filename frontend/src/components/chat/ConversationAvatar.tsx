import type { Conversation } from '@linka/shared';
import { conversationTitle, otherMember } from '../../utils/conversation';
import { Avatar } from '../ui/Avatar';

type Size = 'sm' | 'md' | 'lg';

const box: Record<Size, string> = { sm: 'size-8', md: 'size-10', lg: 'size-14' };
const face: Record<Size, '2xs' | 'xs' | 'md'> = { sm: '2xs', md: 'xs', lg: 'md' };

/**
 * The picture for a conversation. 1:1: the other person. Groups have no picture of their own, so
 * they show two members' faces overlapping (others first, then you), which also tells a group
 * apart from a person at a glance; a group with nobody else left shows its name's initial.
 * `ring` matches the background it sits on, so the front face is cut out cleanly.
 */
export function ConversationAvatar({
  conversation,
  myUserId,
  size = 'md',
  ring = 'canvas',
}: {
  conversation: Conversation;
  myUserId: string;
  size?: Size;
  ring?: 'canvas' | 'surface';
}) {
  const title = conversationTitle(conversation, myUserId);
  if (conversation.type === 'direct') {
    return <Avatar name={title} src={otherMember(conversation, myUserId)?.avatarUrl} size={size} />;
  }

  const others = conversation.members.filter((m) => m.userId !== myUserId);
  const me = conversation.members.find((m) => m.userId === myUserId);
  const [back, front] = others.length >= 2 ? others : [others[0], me];
  if (!back || !front) return <Avatar name={title} size={size} />;

  return (
    <span aria-hidden="true" className={`relative shrink-0 ${box[size]}`}>
      <span className="absolute right-0 top-0">
        <Avatar name={back.displayName} src={back.avatarUrl} size={face[size]} />
      </span>
      <span className={`absolute bottom-0 left-0 rounded-full ring-2 ${ring === 'surface' ? 'ring-surface' : 'ring-canvas'}`}>
        <Avatar name={front.displayName} src={front.avatarUrl} size={face[size]} />
      </span>
    </span>
  );
}
