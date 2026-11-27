import { Alert, Button, Card, CardContent, CardDescription, CardHeader } from '@pb/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { authMode } from '@/lib/env';
import { googleAction } from './actions';
import { LoginForm } from './login-form';
import { Brand } from '@/components/brand';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect('/booths');
  const { error } = await searchParams;
  const supabase = authMode() === 'supabase';

  return (
    <main className="grid min-h-screen bg-canvas lg:grid-cols-[1fr_minmax(28rem,36rem)]">
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-slate-900 via-slate-900 to-primary-hover p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Brand inverted />
        <div className="max-w-md space-y-4">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Desain booth sendiri, jalankan di mana saja.
          </h2>
          <p className="text-white/70">
            Editor visual, pembayaran QRIS ke akun Anda, cetak strip, dan hasil langsung ke Google
            Drive tamu.
          </p>
        </div>
        <p className="text-xs text-white/50">© Photobooth Studio</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-primary/30 blur-3xl"
        />
      </section>
      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm space-y-6">
          <Brand className="lg:hidden" />
          <Card className="shadow-md">
            <CardHeader>
              <h1 className="text-xl font-semibold tracking-tight">Masuk ke Studio</h1>
              <CardDescription>Masuk atau daftar untuk mengelola booth Anda.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <Alert variant="destructive">Gagal masuk. Silakan coba lagi.</Alert>}
              <LoginForm />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                atau
                <span className="h-px flex-1 bg-border" />
              </div>
              <form action={googleAction}>
                <Button type="submit" variant="outline" className="w-full" disabled={!supabase}>
                  Masuk dengan Google
                </Button>
              </form>
              {!supabase && (
                <p className="text-xs text-muted-foreground">
                  Mode dev: login Google aktif saat <code>PB_AUTH_MODE=supabase</code>.
                </p>
              )}
            </CardContent>
          </Card>
          <p className="text-center text-xs text-muted-foreground">
            <Link href="/tentang" className="hover:text-foreground hover:underline">
              Tentang
            </Link>{' '}
            ·{' '}
            <Link href="/privasi" className="hover:text-foreground hover:underline">
              Kebijakan Privasi
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
