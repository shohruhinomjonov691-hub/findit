// Unit tests for findit/web/camera.js with fake getUserMedia / streams (no browser).
// Run: node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { createCamera } = createRequire(import.meta.url)("../../findit/web/camera.js");

function fakeStream() {
  const tracks = ["video", "audio"].map((kind) => ({ kind, readyState: "live", stop() { this.readyState = "ended"; } }));
  return { getTracks: () => tracks, states: () => tracks.map((t) => t.readyState) };
}
function deferredGetUserMedia() {
  const calls = [];
  const gum = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { gum, calls };
}

test("second open while a request is pending is ignored", async () => {
  const { gum, calls } = deferredGetUserMedia();
  const cam = createCamera(gum);
  const first = cam.open({});
  const second = await cam.open({});
  assert.equal(second.status, "ignored");
  assert.equal(calls.length, 1);
  const s = fakeStream();
  calls[0].resolve(s);
  assert.equal((await first).status, "open");
  cam.close();
  assert.deepEqual(s.states(), ["ended", "ended"]);
});

test("close while pending stops every track of the late stream", async () => {
  const { gum, calls } = deferredGetUserMedia();
  const cam = createCamera(gum);
  const pending = cam.open({});
  cam.close();
  const late = fakeStream();
  calls[0].resolve(late);
  assert.equal((await pending).status, "stale");
  assert.deepEqual(late.states(), ["ended", "ended"]);
  assert.equal(cam.stream, null);
  assert.equal(cam.pending, false);
});

test("an older request resolving after a new session is stopped; the new one stays", async () => {
  const { gum, calls } = deferredGetUserMedia();
  const cam = createCamera(gum);
  const old = cam.open({});
  cam.close();
  const current = cam.open({});
  const sCurrent = fakeStream();
  const sOld = fakeStream();
  calls[1].resolve(sCurrent);
  calls[0].resolve(sOld);
  assert.equal((await current).status, "open");
  assert.equal((await old).status, "stale");
  assert.deepEqual(sOld.states(), ["ended", "ended"]);
  assert.deepEqual(sCurrent.states(), ["live", "live"]);
  assert.equal(cam.stream, sCurrent);
  cam.close();
  assert.deepEqual(sCurrent.states(), ["ended", "ended"]);
});

test("a denied request reports the error and allows a new attempt", async () => {
  const { gum, calls } = deferredGetUserMedia();
  const cam = createCamera(gum);
  const p = cam.open({});
  calls[0].reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  const res = await p;
  assert.equal(res.status, "error");
  assert.equal(res.error.name, "NotAllowedError");
  assert.equal(cam.pending, false);
  cam.open({});
  assert.equal(calls.length, 2);
});
