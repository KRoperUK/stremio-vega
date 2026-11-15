// Focused regression tests for the SSRF guard (issue #22).
// Pure unit tests — DNS is stubbed, no network access.

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {assertHostSafe, assertSafeUrl, injectToken, ipIsBlocked, readCappedText} from '../src/guard.js';

const publicResolve = async () => [{address: '93.184.216.0', family: 4}];
const blockedResolve = async () => [{address: '127.0.0.1', family: 4}];

describe('ipIsBlocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.10.20',
    '0.0.0.0',
    '224.0.0.1',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ]) {
    it(`blocks ${ip}`, () => assert.equal(ipIsBlocked(ip), true));
  }

  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.0', '172.32.0.1', '2606:4700:4700::1111']) {
    it(`allows ${ip}`, () => assert.equal(ipIsBlocked(ip), false));
  }
});

describe('assertSafeUrl', () => {
  it('rejects non-http schemes', async () => {
    await assert.rejects(() => assertSafeUrl('ftp://example.com/x', publicResolve), /http\(s\)/);
  });

  it('rejects credentials in the URL', async () => {
    await assert.rejects(
      () => assertSafeUrl('https://user:pass@example.com/', publicResolve),
      /credentials/,
    );
  });

  it('rejects literal loopback IPs', async () => {
    await assert.rejects(() => assertSafeUrl('http://127.0.0.1/addon.json', publicResolve), /blocked/);
    await assert.rejects(() => assertSafeUrl('http://[::1]/x', publicResolve), /blocked/);
  });

  it('rejects hosts resolving to blocked space, incl. mixed records', async () => {
    const mixed = async () => [
      {address: '93.184.216.0', family: 4},
      {address: '10.1.2.3', family: 4},
    ];
    await assert.rejects(() => assertSafeUrl('https://example.com/', blockedResolve), /blocked/);
    await assert.rejects(() => assertSafeUrl('https://example.com/', mixed), /blocked/);
  });

  it('rejects unresolvable hosts', async () => {
    await assert.rejects(() => assertSafeUrl('https://example.com/', async () => []), /resolve/);
  });

  it('accepts a public URL', async () => {
    const u = await assertSafeUrl('https://example.com/catalog.json', publicResolve);
    assert.equal(u.hostname, 'example.com');
  });
});

describe('assertHostSafe', () => {
  it('accepts a literal public IP without resolving', async () => {
    let called = false;
    await assertHostSafe('8.8.8.8', async () => {
      called = true;
      return [];
    });
    assert.equal(called, false);
  });
});

describe('injectToken', () => {
  const page = `<script>window.__VEGA_CONFIG__ = {serverBase: '', token: '__VEGA_TOKEN__'};</script>`;

  it('injects a hostile token so the page still parses and round-trips', () => {
    const token = `a'b"c\\d$&$'e</script><script>alert(1)</script>`;
    const out = injectToken(page, token);
    // No raw placeholder, no literal </script> smuggled in.
    assert.ok(!out.includes('__VEGA_TOKEN__'));
    assert.ok(!out.includes('</script><script>'));
    // The injected script parses and yields the exact token back.
    const script = out.replace(/^<script>|<\/script>$/g, '');
    const window = {};
    new Function('window', script)(window);
    assert.equal(window.__VEGA_CONFIG__.token, token);
  });
});

describe('readCappedText', () => {
  function fakeBody(chunks) {
    const queue = chunks.map((c) => new TextEncoder().encode(c));
    return {
      getReader() {
        return {
          async read() {
            const value = queue.shift();
            return value ? {done: false, value} : {done: true, value: undefined};
          },
          async cancel() {},
        };
      },
    };
  }

  it('reads small bodies', async () => {
    assert.equal(await readCappedText(fakeBody(['{"a":', '1}']), 64), '{"a":1}');
  });

  it('throws once the cap is exceeded', async () => {
    await assert.rejects(() => readCappedText(fakeBody(['x'.repeat(40), 'y'.repeat(40)]), 64), /exceeds/);
  });
});
