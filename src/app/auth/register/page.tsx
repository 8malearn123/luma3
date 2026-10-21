import { RegisterForm } from '@/ui/auth/RegisterForm';

export const metadata = { title: 'Create account' };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <RegisterForm next={next && next.startsWith('/') && !next.startsWith('//') ? next : '/app'} />;
}
