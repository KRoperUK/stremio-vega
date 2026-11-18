// Focused regression tests for the issue #21 server guardrails:
// the /api token gate fails closed, and every response carries baseline
// security headers. Pure unit tests — the middleware is driven directly,
// no socket is bound.

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {securityHeaders, tokenGate} from '../src/guard.js';

function fakeReq({query = {}, headers = {}} = {}) {
  return {
    query,
    get: (name) => headers[name.toLowerCase()] ?? undefined,
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

describe('tokenGate', () => {
  it('fails closed with 503 when no server token is configured', () => {
    const gate = tokenGate(() => '');
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq({query: {t: 'anything'}}), res, () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 503);
  });

  it('rejects a wrong token with 403', () => {
    const gate = tokenGate(() => 'household-secret');
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq({query: {t: 'wrong'}}), res, () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  it('rejects a missing token with 403', () => {
    const gate = tokenGate(() => 'household-secret');
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq(), res, () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  it('accepts the token via query param', () => {
    const gate = tokenGate(() => 'household-secret');
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq({query: {t: 'household-secret'}}), res, () => {
      nexted = true;
    });
    assert.equal(nexted, true);
  });

  it('accepts the token via X-Token header', () => {
    const gate = tokenGate(() => 'household-secret');
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq({headers: {'x-token': 'household-secret'}}), res, () => {
      nexted = true;
    });
    assert.equal(nexted, true);
  });
});

describe('securityHeaders', () => {
  it('sets anti-framing, anti-sniffing, and no-referrer headers', () => {
    const res = fakeRes();
    let nexted = false;
    securityHeaders(fakeReq(), res, () => {
      nexted = true;
    });
    assert.equal(nexted, true);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  });
});
