import { redirect } from 'next/navigation';

/** Verification happens inline after registration; this route keeps old links working. */
export default function VerifyPage() { redirect('/auth/register'); }
