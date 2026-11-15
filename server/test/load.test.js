// Focused regression tests for bounded streaming load (issue #23).

import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TRANSCODES,
  PROBE_CACHE_TTL_MS,
  cachedProbe,
  probeCache,
  releaseTranscode,
  tryAcquireTranscode,
} from '../src/stream.js';

beforeEach(() => {
  probeCache.clear();
  releaseTranscode();
  releaseTranscode();
});

describe('transcode slots', () => {
  it(`admits ${MAX_TRANSCODES} then refuses`, () => {
    assert.equal(MAX_TRANSCODES, 2);
    assert.equal(tryAcquireTranscode(), true);
    assert.equal(tryAcquireTranscode(), true);
    assert.equal(tryAcquireTranscode(), false);
  });

  it('release frees a slot, and never underflows', () => {
    assert.equal(tryAcquireTranscode(), true);
    releaseTranscode();
    releaseTranscode(); // extra release must not create phantom capacity
    assert.equal(tryAcquireTranscode(), true);
    assert.equal(tryAcquireTranscode(), true);
    assert.equal(tryAcquireTranscode(), false);
  });
});

describe('cachedProbe', () => {
  it('replays a recent probe without calling probe again', async () => {
    let calls = 0;
    const fake = async (url) => {
      calls += 1;
      return {container: 'mp4', video: 'h264', audio: 'aac', url};
    };
    const first = await cachedProbe('https://cdn.example/v.mp4', fake);
    const second = await cachedProbe('https://cdn.example/v.mp4', fake);
    assert.equal(calls, 1);
    assert.equal(second, first);
  });

  it('re-probes once the entry is stale', async () => {
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return {container: 'mp4', video: 'h264', audio: null};
    };
    await cachedProbe('https://cdn.example/old.mp4', fake);
    probeCache.get('https://cdn.example/old.mp4').at = Date.now() - PROBE_CACHE_TTL_MS - 1;
    await cachedProbe('https://cdn.example/old.mp4', fake);
    assert.equal(calls, 2);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('ffprobe timed out');
    };
    await assert.rejects(() => cachedProbe('https://cdn.example/hang.mp4', failing), /timed out/);
    await assert.rejects(() => cachedProbe('https://cdn.example/hang.mp4', failing), /timed out/);
    assert.equal(calls, 2);
  });
});
