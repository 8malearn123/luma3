'use client';

import { useEffect } from 'react';
import { track, type TrackEventType } from './track';

/** Fires one view event after mount. Rendered on published storefront pages only. */
export function TrackView({ slug, type, entityId }: { slug: string; type: TrackEventType; entityId?: string }) {
  useEffect(() => { track(slug, type, entityId); }, [slug, type, entityId]);
  return null;
}
