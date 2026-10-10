import { describe, expect, it } from 'vitest';
import { acquireSelection, type AcquireDeps } from '../../src/capture/acquire';
import { EXCERPT_MAX_CHARS } from '../../src/capture/parse';
import { checkSourceUrl, isValidSourcePath, sanitizeSourcePath } from '../../src/capture/source';

describe('checkSourceUrl', () => {
  it.each([
    ['https://www.amazon.com/gp/your-account/order-details?orderID=1', 'https://www.amazon.com'],
    ['https://amazon.com/', 'https://amazon.com'],
    ['https://WWW.AMAZON.COM/x', 'https://www.amazon.com'],
    ['https://www.amazon.com:443/x', 'https://www.amazon.com'],
  ])('accepts %s', (url, origin) => {
    expect(checkSourceUrl(url)).toEqual({ ok: true, origin });
  });

  it.each([
    [undefined, 'no_access'],
    ['', 'no_access'],
    ['http://www.amazon.com/', 'unsupported_scheme'],
    ['file:///home/amazon.com.html', 'unsupported_scheme'],
    ['chrome://extensions', 'restricted'],
    ['chrome-extension://abc/dashboard.html', 'restricted'],
    ['about:blank', 'restricted'],
    ['https://chromewebstore.google.com/detail/x', 'restricted'],
    ['https://www.amazon.co.uk/', 'unsupported_host'],
    ['https://www.amazon.ca/', 'unsupported_host'],
    ['https://smile.amazon.com/', 'unsupported_host'],
    ['https://www.amazon.com.evil.example/', 'unsupported_host'],
    ['https://evil-amazon.com/', 'unsupported_host'],
    ['https://www.amazon.com.:443/', 'unsupported_host'],
    ['https://www.amazon.com:8443/', 'unsupported_host'],
    ['https://user:pw@www.amazon.com/', 'unsupported_host'],
    ['https://xn--amazn-mua.com/', 'unsupported_host'],
    ['https://www.amazon.com@evil.example/', 'unsupported_host'],
  ])('rejects %s', (url, problem) => {
    expect(checkSourceUrl(url)).toEqual({ ok: false, problem });
  });
});

describe('sanitizeSourcePath', () => {
  it('drops fragments, tracking segments and every query parameter except a valid order ID', () => {
    expect(sanitizeSourcePath('https://www.amazon.com/gp/your-account/order-details/ref=ppx_yo_dt_b?ie=UTF8&orderID=112-1234567-7654321&session-id=999&tag=x#secret')).toBe(
      '/gp/your-account/order-details?orderID=112-1234567-7654321',
    );
    expect(sanitizeSourcePath('https://www.amazon.com/spr/returns/cart?token=abc&orderId=junk')).toBe('/spr/returns/cart');
    expect(sanitizeSourcePath(`https://www.amazon.com/${'a'.repeat(400)}`)).toBeNull();
    expect(sanitizeSourcePath('https://www.amazon.com/a b')).toBe('/a%20b');
  });
  it('validates stored paths', () => {
    expect(isValidSourcePath('/gp/x?orderID=112-1234567-7654321')).toBe(true);
    expect(isValidSourcePath('/gp/x?token=1')).toBe(false);
    expect(isValidSourcePath('/gp/x#frag')).toBe(false);
    expect(isValidSourcePath('gp/x')).toBe(false);
  });
});

function deps(over: Partial<{ url: string | undefined; closed: boolean; injectError: string; result: unknown }> = {}): AcquireDeps & { injected: number } {
  const d = {
    injected: 0,
    async getTab() {
      if (over.closed) throw new Error('No tab with id: 5');
      return { url: 'url' in over ? over.url : 'https://www.amazon.com/gp/css/order-details' };
    },
    async inject() {
      d.injected += 1;
      if (over.injectError) throw new Error(over.injectError);
      return 'result' in over ? over.result : { status: 'ok', href: 'https://www.amazon.com/gp/css/order-details?ref_=x#y', text: 'Refund issued: $70.00' };
    },
  };
  return d;
}

describe('acquireSelection', () => {
  it('reads the selection from the fixed tab and returns sanitised provenance', async () => {
    expect(await acquireSelection(deps(), 5, 'https://www.amazon.com')).toEqual({
      ok: true,
      text: 'Refund issued: $70.00',
      sourceOrigin: 'https://www.amazon.com',
      sourcePath: '/gp/css/order-details',
    });
  });

  it('never injects into an unsupported, inaccessible or closed tab', async () => {
    for (const [d, problem] of [
      [deps({ url: undefined }), 'no_access'],
      [deps({ url: 'https://www.amazon.co.uk/' }), 'unsupported_host'],
      [deps({ url: 'chrome://newtab' }), 'restricted'],
      [deps({ closed: true }), 'tab_closed'],
    ] as const) {
      expect(await acquireSelection(d, 5, null)).toMatchObject({ ok: false, problem });
      expect(d.injected).toBe(0);
    }
    expect(await acquireSelection(deps(), null, null)).toMatchObject({ ok: false, problem: 'no_tab' });
  });

  it('detects navigation before and during injection', async () => {
    expect(await acquireSelection(deps({ url: 'https://amazon.com/' }), 5, 'https://www.amazon.com')).toMatchObject({ problem: 'navigated' });
    expect(await acquireSelection(deps({ result: { status: 'ok', href: 'https://www.amazon.co.uk/', text: 'Refund issued: $70.00' } }), 5, null)).toMatchObject({ problem: 'navigated' });
    expect(await acquireSelection(deps({ injectError: 'Frame with ID 0 was removed.' }), 5, null)).toMatchObject({ problem: 'navigated' });
    expect(await acquireSelection(deps({ injectError: 'Cannot access contents of url "https://www.amazon.com/". Extension manifest must request permission to access this host.' }), 5, null)).toMatchObject({ problem: 'no_access' });
    expect(await acquireSelection(deps({ injectError: 'No tab with id: 5.' }), 5, null)).toMatchObject({ problem: 'tab_closed' });
  });

  it('treats page output as untrusted and enforces the size bound', async () => {
    expect(await acquireSelection(deps({ result: { status: 'ok', href: 'https://www.amazon.com/', text: 7 } }), 5, null)).toMatchObject({ problem: 'injection_failed' });
    expect(await acquireSelection(deps({ result: undefined }), 5, null)).toMatchObject({ problem: 'injection_failed' });
    expect(await acquireSelection(deps({ result: { status: 'ok', href: 'https://www.amazon.com/', text: 'x'.repeat(EXCERPT_MAX_CHARS + 1) } }), 5, null)).toMatchObject({ problem: 'too_long' });
    expect(await acquireSelection(deps({ result: { status: 'too_long', href: 'https://www.amazon.com/', length: 9000 } }), 5, null)).toEqual({ ok: false, problem: 'too_long', length: 9000 });
    expect(await acquireSelection(deps({ result: { status: 'editable', href: 'https://www.amazon.com/' } }), 5, null)).toMatchObject({ problem: 'editable' });
    expect(await acquireSelection(deps({ result: { status: 'empty', href: 'https://www.amazon.com/' } }), 5, null)).toMatchObject({ problem: 'empty' });
  });
});
