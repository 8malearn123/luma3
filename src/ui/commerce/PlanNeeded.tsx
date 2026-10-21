'use client';

import { Sparkles } from 'lucide-react';
import { EmptyState } from '../components/feedback';
import { PageHeader } from '../components/layout';

/** Shown instead of a feature page when the plan does not include it (server enforces regardless). */
export function PlanNeeded({ title, message }: { title: string; message: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <EmptyState icon={<Sparkles className="size-8" aria-hidden />} title={message} />
    </div>
  );
}
