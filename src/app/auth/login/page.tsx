import { LoginForm } from '@/ui/auth/LoginForm';
import { env } from '@/server/env';
import { safeInternalPath } from '@/shared/safe-path';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Only same-site relative paths are accepted as post-login destinations.
  const safeNext = safeInternalPath(next, '/app');
  return <LoginForm next={safeNext} demo={env().demoEnabled} />;
}
