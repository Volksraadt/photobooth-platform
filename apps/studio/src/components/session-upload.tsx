import { RetryUploadButton } from '@/app/(app)/booths/[boothId]/transactions/retry-button';
import { uploadState } from '@/lib/upload-status';

export function UploadCell({
  session,
  jobs,
}: {
  session: Parameters<typeof uploadState>[0] & { id: string; code: string };
  jobs: Parameters<typeof uploadState>[1];
}) {
  const u = uploadState(session, jobs);
  const tone =
    u.kind === 'done'
      ? 'text-success'
      : u.kind === 'failed'
        ? 'text-destructive'
        : u.kind === 'retrying'
          ? 'text-warning'
          : 'text-muted-foreground';
  return (
    <div className="space-y-1">
      <div className={tone}>
        {u.driveUrl ? (
          <a className="underline" href={u.driveUrl} target="_blank" rel="noreferrer">
            {u.label}
          </a>
        ) : (
          u.label
        )}
      </div>
      {u.detail && <div className="max-w-xs text-xs text-muted-foreground">{u.detail}</div>}
      {u.canRetry && <RetryUploadButton sessionId={session.id} code={session.code} />}
    </div>
  );
}
