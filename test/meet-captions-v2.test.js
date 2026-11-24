// Regression: Google Meet renamed its caption data channel to "captions_v2".
//
// Tactiq 3.1.7673 (Nov 19) watches and opens BOTH "captions" and "captions_v2",
// and only accepts a caption frame when it is a real transcript message:
//   * a wrapper carrying field 2 ("unknown2") is a control frame -> ignore
//   * deviceId, messageId, messageVersion and langId must all be present
// A tap that only knows "captions" receives nothing on current Meet.
//
// Run: npm i jsdom && node test/meet-captions-v2.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', {
  runScripts: 'outside-only', url: 'https://meet.google.com/abc-defg-hij',
});
const { window } = dom;
window.TextDecoder = require('util').TextDecoder;
window.TextEncoder = require('util').TextEncoder;

const channels = [];
class FakeChannel {
  constructor(label) { this.label = label; this.readyState = 'open'; this._l = {}; channels.push(this); }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  send() {}
  fire(data) { (this._l.message || []).forEach(fn => fn({ data })); }
  close() { this.readyState = 'closed'; (this._l.close || []).forEach(fn => fn({})); }
}
class FakePC {
  constructor() { this._l = {}; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  createDataChannel(label) { return new FakeChannel(label); }
  emitRemote(ch) { (this._l.datachannel || []).forEach(fn => fn({ channel: ch })); }
}
window.RTCPeerConnection = FakePC;
// Same fast timings the other Meet tests use; production batches captions.
window.__LS_MEET_CONFIG__ = { batchMs: 20, openDelayMs: 10, healthMs: 1000 };
window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'meetrtc.js'), 'utf8'));

const got = [];
window.document.documentElement.addEventListener('livescribe-meet', ev => {
  if (ev.detail && ev.detail.type === 'speech') got.push(ev.detail);
});

function varint(n) { const o = []; while (n > 127) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; }
const tag = (f, w) => varint((f << 3) | w);
const pStr = (f, v) => { const b = [...Buffer.from(v, 'utf8')]; return [...tag(f, 2), ...varint(b.length), ...b]; };
const pInt = (f, v) => [...tag(f, 0), ...varint(v)];
const pMsg = (f, inner) => [...tag(f, 2), ...varint(inner.length), ...inner];

function caption({ deviceId, messageId, version, text, lang = 1, control = false }) {
  const msg = [...pStr(1, deviceId), ...pInt(2, messageId), ...pInt(3, version), ...pStr(6, text)];
  if (lang != null) msg.push(...pInt(8, lang));
  const wrapper = [...pMsg(1, msg)];
  if (control) wrapper.push(...pStr(2, 'ctl'));
  return new Uint8Array(wrapper).buffer;
}

const pc = new window.RTCPeerConnection();

setTimeout(() => {
  const ownLabels = channels.map(c => c.label);

  // Current Meet delivers captions on "captions_v2".
  const v2 = new FakeChannel('captions_v2');
  pc.emitRemote(v2);
  v2.fire(caption({ deviceId: 'dev/A', messageId: 7, version: 1, text: 'we ship onboarding on Friday' }));
  // Control frame (wrapper field 2 set) — must be ignored.
  v2.fire(caption({ deviceId: 'dev/A', messageId: 8, version: 1, text: 'CONTROL FRAME', control: true }));
  // Missing langId — must be ignored.
  v2.fire(caption({ deviceId: 'dev/A', messageId: 9, version: 1, text: 'NO LANG ID', lang: null }));

  // The old label must keep working.
  const v1 = new FakeChannel('captions');
  pc.emitRemote(v1);
  v1.fire(caption({ deviceId: 'dev/B', messageId: 3, version: 1, text: 'old channel still works' }));

  // The live channel on current Meet is captions_v2: if it drops, it must be
  // reopened — and only that label, not a duplicate "captions".
  // `v2` (the remote one) superseded our own captions_v2, so it is the active one.
  const v2Before = channels.filter(c => c.label === 'captions_v2').length;
  const v1Before = channels.filter(c => c.label === 'captions').length;
  v2.close();

  setTimeout(() => {
    const v2Reopened = channels.filter(c => c.label === 'captions_v2').length > v2Before;
    const v1Untouched = channels.filter(c => c.label === 'captions').length === v1Before;
    const texts = got.map(g => g.text);
    console.log('own channels opened:', JSON.stringify(ownLabels));
    console.log('speech:', JSON.stringify(texts));

    const opensV2 = ownLabels.includes('captions_v2') && ownLabels.includes('captions');
    const readsV2 = texts.includes('we ship onboarding on Friday');
    const readsV1 = texts.includes('old channel still works');
    const noControl = !texts.includes('CONTROL FRAME');
    const noPartial = !texts.includes('NO LANG ID');

    console.log('---');
    console.log('opens captions + captions_v2 :', opensV2 ? 'PASS' : 'FAIL');
    console.log('reads captions_v2            :', readsV2 ? 'PASS' : 'FAIL');
    console.log('still reads captions         :', readsV1 ? 'PASS' : 'FAIL');
    console.log('control frame ignored        :', noControl ? 'PASS' : 'FAIL');
    console.log('frame without langId ignored :', noPartial ? 'PASS' : 'FAIL');
    console.log('dropped captions_v2 reopened :', v2Reopened && v1Untouched ? 'PASS' : 'FAIL');
    const ok = opensV2 && readsV2 && readsV1 && noControl && noPartial && v2Reopened && v1Untouched;
    console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
    process.exit(ok ? 0 : 1);
  }, 300);
}, 400);
