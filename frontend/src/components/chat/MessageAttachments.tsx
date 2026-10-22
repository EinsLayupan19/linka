import { useState } from 'react';
import type { Attachment } from '@linka/shared';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { fileBadge, formatBytes, isImage } from '../../utils/attachments';

const linkFocus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current';

/** One image. Opens full size in a new tab (served from Storage, never from this site). */
function ImageAttachment({ attachment, single }: { attachment: Attachment; single: boolean }) {
  const { state, reload } = useAttachmentUrl(attachment.id);
  // One automatic retry with a fresh URL (an old URL may have expired), then show the problem.
  const [failures, setFailures] = useState(0);
  const box = single ? 'block max-h-80 w-full max-w-72' : 'block aspect-square w-full';

  if (state.status === 'loading') {
    return <span role="img" aria-label={`Loading ${attachment.fileName}`} className={`${box} ${single ? 'aspect-[4/3]' : ''} rounded-lg bg-skeleton`} />;
  }
  if (state.status !== 'ready' || failures > 1) {
    return (
      <span className={`${box} ${single ? 'aspect-[4/3]' : ''} grid place-items-center rounded-lg border border-current/20 p-2 text-center text-xs`}>
        <span>
          {state.status === 'missing' ? 'Image unavailable' : 'Could not load image'}
          {state.status !== 'missing' && (
            <button
              type="button"
              onClick={() => {
                setFailures(0);
                reload();
              }}
              className={`mt-1 block w-full rounded-sm font-semibold underline underline-offset-2 ${linkFocus}`}
            >
              Retry
            </button>
          )}
        </span>
      </span>
    );
  }
  return (
    <a href={state.url} target="_blank" rel="noopener noreferrer" className={`overflow-hidden rounded-lg ${box} ${linkFocus}`}>
      <img
        src={state.url}
        alt={attachment.fileName}
        loading="lazy"
        decoding="async"
        onError={() => {
          setFailures((n) => n + 1);
          if (failures === 0) reload();
        }}
        className={`size-full bg-skeleton ${single ? 'max-h-80 object-contain' : 'object-cover'}`}
      />
    </a>
  );
}

/** A file row with a download link (the signed URL plus Storage's download flag, named after the file). */
function FileAttachment({ attachment }: { attachment: Attachment }) {
  const { state, reload } = useAttachmentUrl(attachment.id);
  const href = state.status === 'ready' ? `${state.url}${state.url.includes('?') ? '&' : '?'}download=${encodeURIComponent(attachment.fileName)}` : null;

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-current/20 px-2.5 py-2">
      <span aria-hidden="true" className="grid h-9 w-10 shrink-0 place-items-center rounded-sm border border-current/20 text-[10px] font-semibold tracking-wide">
        {fileBadge(attachment.fileName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={attachment.fileName}>
          {attachment.fileName}
        </span>
        <span className="block text-xs opacity-80">{formatBytes(attachment.sizeBytes)}</span>
      </span>
      {href ? (
        <a
          href={href}
          rel="noopener noreferrer"
          aria-label={`Download ${attachment.fileName}`}
          className={`shrink-0 rounded-sm text-sm font-semibold underline underline-offset-2 ${linkFocus}`}
        >
          Download
        </a>
      ) : state.status === 'loading' ? (
        <span className="shrink-0 text-xs opacity-80">Preparing…</span>
      ) : state.status === 'missing' ? (
        <span className="shrink-0 text-xs opacity-80">Unavailable</span>
      ) : (
        <button type="button" onClick={reload} className={`shrink-0 rounded-sm text-sm font-semibold underline underline-offset-2 ${linkFocus}`}>
          Retry
        </button>
      )}
    </div>
  );
}

/** A message's attachments: images in a grid, then files as rows. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter(isImage);
  const files = attachments.filter((a) => !isImage(a));
  return (
    <div className="grid gap-1.5">
      {images.length > 0 && (
        <div className={images.length === 1 ? '' : 'grid grid-cols-2 gap-1'}>
          {images.map((image) => (
            <ImageAttachment key={image.id} attachment={image} single={images.length === 1} />
          ))}
        </div>
      )}
      {files.map((file) => (
        <FileAttachment key={file.id} attachment={file} />
      ))}
    </div>
  );
}
