import { PageHeader } from '@pb/ui';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { isPlatformAdmin } from '@/lib/entitlements';
import { TemplatesManager, type AdminTemplate } from './templates-manager';

/** Platform admin: booth templates owners choose from when creating a booth. */
export default async function AdminTemplatesPage() {
  const user = await requireUser();
  if (!isPlatformAdmin(user)) notFound();
  const res = await apiFetch('/admin/templates');
  if (!res.ok) notFound();
  const { templates } = (await res.json()) as { templates: AdminTemplate[] };
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href="/admin">Admin platform</BackLink>}
        title="Template booth"
        description={
          <>
            Template tampil di galeri saat owner membuat booth baru. Untuk menambah template, buka
            booth yang desainnya sudah jadi lalu pilih <b>Simpan sebagai template</b> (hanya
            terlihat oleh admin platform). Template bawaan bisa disembunyikan, tetapi tidak dihapus.
          </>
        }
      />
      <TemplatesManager templates={templates} />
    </div>
  );
}
