import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CONVERSATION_NAME_MAX_LENGTH, createConversationSchema, type UserSummary } from '@linka/shared';
import { PeoplePicker } from '../components/people/PeoplePicker';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { useChats } from '../hooks/useChats';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ApiError, toApiError } from '../lib/api';
import { createGroup } from '../services/conversations';
import { fieldErrors } from '../utils/formErrors';

/** Name a group and choose its first members; you become its owner. */
export function NewGroup() {
  useDocumentTitle('New group');
  const navigate = useNavigate();
  const { upsertConversation } = useChats();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<UserSummary[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    // The same rules the API applies: a name, and at least one other person.
    const parsed = createConversationSchema.safeParse({ type: 'group', name, memberIds: members.map((m) => m.id) });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    if (parsed.data.type !== 'group') return;
    setErrors({});
    setSubmitting(true);
    try {
      const conversation = await createGroup(parsed.data.name, parsed.data.memberIds);
      upsertConversation(conversation);
      navigate(`/conversations/${conversation.id}`, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.fields) setErrors(error.fields);
      else setFormError(toApiError(error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link
          to="/conversations/new"
          className="rounded-lg px-1 text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Back
        </Link>
        <h1 className="font-semibold">New group</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <form noValidate onSubmit={handleSubmit} className="grid max-w-md gap-5">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <TextField
            label="Group name"
            autoComplete="off"
            maxLength={CONVERSATION_NAME_MAX_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            error={errors.name}
          />
          <PeoplePicker
            label="Members"
            selected={members}
            onChange={(next) => {
              setMembers(next);
              // Choosing someone answers "add at least one member"; the name error stays.
              if (errors.memberIds) setErrors(errors.name ? { name: errors.name } : {});
            }}
            disabled={submitting}
            error={errors.memberIds}
          />
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create group'}
            </Button>
          </div>
          <p className="text-sm text-ink-muted">You will be the group’s owner. You can add or remove people later.</p>
        </form>
      </div>
    </div>
  );
}
