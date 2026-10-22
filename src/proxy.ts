import { NextResponse, type NextRequest } from 'next/server';

/** Exposes the request path to server components (used for login "next" redirects). */
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-pathname', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!api|_next|brand|favicon).*)'] };
