import { RegisterForm } from '@/ui/auth/RegisterForm';
import { AuthUnavailable } from '@/ui/auth/AuthUnavailable';
import { codeDeliveryAvailable } from '@/server/auth/service';
import { safeInternalPath } from '@/shared/safe-path';

export const metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = safeInternalPath(next, '/app');
  // No messaging provider (e.g. a deployed review build): an account could never be verified (R3).
  if (!codeDeliveryAvailable()) return <AuthUnavailable kind="register" next={safeNext} />;
  return <RegisterForm next={safeNext} />;
}
