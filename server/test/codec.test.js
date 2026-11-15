// Focused regression tests for the codec decision (issue #24): which inputs
// play as-is, which are repacked, and which are re-encoded — plus the resume
// offset baked into the ffmpeg invocation for non-passthrough output.

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {decide} from '../src/codec.js';
import {buildArgs} from '../src/stream.js';

describe('decide', () => {
  it('passes through native codecs in a native container', () => {
    const plan = decide({container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'aac'});
    assert.equal(plan.passthrough, true);
    assert.equal(plan.reason, 'native');
    assert.equal(plan.remuxOnly, false);
  });

  it('transcodes (not remuxes) a non-native video codec', () => {
    const plan = decide({container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'mpeg2video', audio: 'aac'});
    assert.equal(plan.passthrough, false);
    assert.equal(plan.remuxOnly, false);
    assert.match(plan.reason, /video mpeg2video/);
  });

  it('transcodes (not remuxes) a non-native audio codec', () => {
    const plan = decide({container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'dts'});
    assert.equal(plan.passthrough, false);
    assert.equal(plan.remuxOnly, false);
    assert.match(plan.reason, /audio dts/);
  });

  it('remuxes a bad container holding native codecs', () => {
    const plan = decide({container: 'avi', video: 'h264', audio: 'mp3'});
    assert.equal(plan.passthrough, false);
    assert.equal(plan.remuxOnly, true);
    assert.match(plan.reason, /container avi needs remux/);
  });

  it('repacks a .ts with standard codecs instead of re-encoding', () => {
    const plan = decide({container: 'mpegts', video: 'h264', audio: 'aac'});
    assert.equal(plan.passthrough, false);
    assert.equal(plan.remuxOnly, true);
    assert.match(plan.reason, /needs remux/);
  });

  it('transcodes a .ts with a non-native video codec', () => {
    const plan = decide({container: 'mpegts', video: 'mpeg2video', audio: 'mp2'});
    assert.equal(plan.passthrough, false);
    assert.equal(plan.remuxOnly, false);
  });
});

describe('buildArgs resume offset', () => {
  const remux = {
    passthrough: false,
    remuxOnly: true,
    reason: 'container mpegts needs remux',
    video: 'h264',
    audio: 'aac',
    container: 'mpegts',
  };

  it('starts from the beginning when no offset is given', () => {
    const args = buildArgs('https://cdn.example/f.ts', remux);
    assert.ok(!args.includes('-ss'));
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), [
      '-i',
      'https://cdn.example/f.ts',
    ]);
  });

  it('seeks the input when a resume offset is given', () => {
    const args = buildArgs('https://cdn.example/f.ts', remux, 312.7);
    const ss = args.indexOf('-ss');
    assert.ok(ss >= 0);
    assert.equal(args[ss + 1], '312.7');
    // Input seeking: -ss must come before -i.
    assert.ok(ss < args.indexOf('-i'));
  });

  it('copies (never re-encodes) a remux plan with an offset', () => {
    const args = buildArgs('https://cdn.example/f.ts', remux, 60);
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('copy'));
    assert.ok(!args.includes('libx264'));
  });
});
