import { RecoverForm } from '@/ui/auth/RecoverForm';
import { AuthUnavailable } from '@/ui/auth/AuthUnavailable';
import { codeDeliveryAvailable } from '@/server/auth/service';

export const metadata = { title: 'Reset password' };
export const dynamic = 'force-dynamic';

export default function RecoverPage() {
  // No messaging provider: the code cannot reach anyone, and it is never shown on screen (R3).
  if (!codeDeliveryAvailable()) return <AuthUnavailable kind="recover" />;
  return <RecoverForm />;
}
