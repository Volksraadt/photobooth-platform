'use client';

import { Button, Input, Label } from '@pb/ui';
import { useActionState } from 'react';
import { FormMessage } from '@/components/form-message';
import { IDLE } from '@/lib/form';
import { authAction } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState(authAction, IDLE);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Kata sandi</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={8}
          required
        />
      </div>
      <FormMessage state={state} />
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="signin" className="flex-1" loading={pending}>
          Masuk
        </Button>
        <Button
          type="submit"
          name="intent"
          value="signup"
          variant="outline"
          className="flex-1"
          disabled={pending}
        >
          Daftar
        </Button>
      </div>
    </form>
  );
}
