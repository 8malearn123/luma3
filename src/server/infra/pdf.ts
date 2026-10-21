import { Errors } from '../http/errors';

/**
 * HTML → PDF through headless Chromium (playwright-core). Chosen because Arabic
 * receipts need correct shaping and bidirectional layout, which browser text
 * rendering handles. If no Chromium binary is available, callers get an
 * honest 503 and the printable HTML view remains available.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw Errors.unavailable('pdf_renderer_unavailable', 'PDF rendering is not available on this server');
  }
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-gpu'] });
  } catch {
    throw Errors.unavailable('pdf_renderer_unavailable', 'PDF rendering is not available on this server');
  }
  try {
    const page = await browser.newPage();
    // No network: the document is self-contained (fonts fall back to system Arabic fonts).
    await page.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } }));
  } finally {
    await browser.close();
  }
}

export function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
