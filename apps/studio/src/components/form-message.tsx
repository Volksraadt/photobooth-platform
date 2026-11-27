import { Alert } from '@pb/ui';
import type { FormState } from '@/lib/form';

export function FormMessage({ state }: { state: FormState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'warning') return <Alert variant="warning">{state.message}</Alert>;
  return (
    <Alert variant={state.status === 'error' ? 'destructive' : 'success'}>{state.message}</Alert>
  );
}
