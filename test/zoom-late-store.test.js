// Regression: the Zoom meeting store already exists before zoomstore.js runs.
//
// This is what happened in the real 35-minute meeting : patching
// createStore only catches a store built AFTER the hook, so no caption ever came
// from the store, the DOM fallback ran the whole call, and the export had
// "Speaker", initials, caption text in the speaker field, and every sentence
// repeated many times.
//
// Tactiq 3.1.7673 recovers an already-built store from the React tree (the
// <Provider store> fiber) and reads captions from STATE —
// state.newLiveTranscription.newLTMessage — instead of intercepting actions, so
// timing no longer matters. This test builds the store first, then loads the
// tap, and expects real names, stable ids, and the meeting topic.
//
// Run: npm i jsdom && node test/zoom-late-store.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body><div id="portal"></div><div id="root"></div></body>', {
  runScripts: 'outside-only', url: 'https://app.zoom.us/wc/123/start',
});
const { window } = dom;
const doc = window.document;

function makeStore(initial) {
  let state = initial;
  const subs = [];
  return {
    getState: () => state,
    subscribe(fn) { subs.push(fn); return () => {}; },
    dispatch(next) { state = next(state); subs.forEach(f => f()); },
  };
}

// The meeting store, built BEFORE the tap is loaded.
const meeting = makeStore({
  meeting: { meetingTopic: 'CDR review', meetingJoinStatus: 'joined' },
  newLiveTranscription: { newLTMessage: {} },
});
// The Zoom Workplace shell's own store — must NOT be picked.
const portal = makeStore({ contacts: {}, meetings: {} });

// Mount both under React-18-style root containers with a fiber tree.
const fiber = (store) => ({ memoizedProps: {}, sibling: null,
  child: { memoizedProps: { children: 1 }, sibling: null,
    child: { memoizedProps: { store }, child: null, sibling: null } } });
doc.getElementById('portal')['__reactContainer$x1'] = fiber(portal);
doc.getElementById('root')['__reactContainer$x2'] = fiber(meeting);

window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'zoomstore.js'), 'utf8'));

const got = [];
doc.documentElement.addEventListener('livescribe-zoom', ev => got.push(ev.detail));

const msg = (id, uid, name, text) => ({ msgId: id, text, language: 'en', user: { zoomID: uid, displayName: name } });
const put = (...ms) => meeting.dispatch(s => ({ ...s, newLiveTranscription: {
  newLTMessage: { ...s.newLiveTranscription.newLTMessage, ...Object.fromEntries(ms.map(m => [m.msgId, m])) } } }));

setTimeout(() => {
  put(msg('m1', 'u2', 'Avery Stone', "We've got your agenda here"));
  put(msg('m1', 'u2', 'Avery Stone', "We've got your agenda here. Do you have the report?"));
  put(msg('m2', 'u1', 'Riley Park', 'I think I forgot one of the documents'));

  setTimeout(() => {
    const speech = got.filter(d => d.type === 'speech');
    const topic = got.find(d => d.type === 'topic');
    console.log('speech events:', speech.length);
    speech.forEach(d => console.log(`  [${d.id}] ${d.speaker}: ${d.text}`));
    console.log('topic        :', topic && topic.topic);

    const names = speech.some(d => d.speaker === 'Avery Stone') && speech.some(d => d.speaker === 'Riley Park');
    const stableId = speech.filter(d => d.id === 'm1/u2').length === 2;
    const revised = speech.some(d => d.id === 'm1/u2' && /report\?$/.test(d.text));
    const noPortal = !speech.some(d => /contacts/.test(d.text || ''));

    console.log('---');
    console.log('late store recovered + real names:', names ? 'PASS' : 'FAIL');
    console.log('revision keeps msgId             :', stableId && revised ? 'PASS' : 'FAIL');
    console.log('meeting topic (not "Home")       :', topic && topic.topic === 'CDR review' ? 'PASS' : 'FAIL');
    console.log('portal store ignored             :', noPortal ? 'PASS' : 'FAIL');
    const ok = names && stableId && revised && topic && topic.topic === 'CDR review' && noPortal;
    console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
    process.exit(ok ? 0 : 1);
  }, 200);
}, 400);   // give the discovery poll time to find the store
