import { listMyOrgs } from '@pb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pb/ui';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { asUser } from '@/lib/org';
import { OrgForm } from './org-form';

export default async function OnboardingPage() {
  const user = await requireUser();
  const orgs = await asUser(user, (tx) => listMyOrgs(tx));
  if (orgs.length > 0) redirect('/booths');

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Buat organisasi</CardTitle>
          <CardDescription>
            Organisasi menampung semua booth, frame, dan laporan Anda.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrgForm />
        </CardContent>
      </Card>
    </main>
  );
}
