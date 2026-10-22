import { RegisterForm } from '@/ui/auth/RegisterForm';
import { safeInternalPath } from '@/shared/safe-path';

export const metadata = { title: 'Create account' };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <RegisterForm next={safeInternalPath(next, '/app')} />;
}
