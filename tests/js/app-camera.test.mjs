// Loads the real findit/web/app.js (with i18n.js, search.js, camera.js) into a vm
// context with a minimal fake DOM, then drives the camera through app.js's own
// event listeners. The fake <dialog> follows the HTML rule that close() hides the
// dialog at once but delivers the "close" event later; tests deliver it by hand.
// This is a Node harness, not a browser: it checks app.js's wiring and ordering,
// not real browser event timing. Run: node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStream, flush, loadApp, openWithStream } from "./harness.mjs";

test("stale close event after Cancel → reopen does not close the new session", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s1 = await openWithStream(app);
  app.$("cameraCancel").click();
  assert.ok(s1.ended(), "Cancel stops the first stream");
  assert.equal(dialog.queued.length, 1, "close event still queued");

  const s2 = await openWithStream(app);
  assert.equal(dialog.open, true);
  dialog.deliverClose(); // the first session's close event arrives late

  assert.equal(dialog.open, true, "new session's dialog stays open");
  assert.ok(s2.live(), "new session's stream keeps running");
  assert.equal(app.$("cameraVideo").srcObject, s2);
  assert.equal(app.$("cameraShoot").disabled, false);

  app.$("cameraCancel").click();
  dialog.deliverClose();
  assert.ok(s2.ended());
});

test("stale close event while the reopened request is still pending does not cancel it", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  await openWithStream(app);
  app.$("cameraCancel").click();
  app.$("cameraBtn").click(); // second request pending
  dialog.deliverClose();
  const s2 = fakeStream();
  app.calls.at(-1).resolve(s2);
  await flush();
  assert.equal(dialog.open, true);
  assert.ok(s2.live());
  assert.equal(app.$("cameraVideo").srcObject, s2);
});

test("a close started by the browser stops the stream", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  dialog.closeByBrowser();
  dialog.deliverClose();
  assert.ok(s.ended());
  assert.equal(app.$("cameraVideo").srcObject, null);
});

test("Escape stops the stream and closes the dialog", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  const esc = new Event("keydown");
  esc.key = "Escape";
  app.doc.dispatchEvent(esc); // app.js listens for keydown on document
  assert.ok(s.ended());
  assert.equal(dialog.open, false);
  dialog.deliverClose();
  assert.ok(s.ended());
});

test("Capture stops the stream and closes the dialog", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  app.$("cameraVideo").videoWidth = 640;
  app.$("cameraVideo").videoHeight = 480;
  app.$("cameraShoot").click();
  assert.ok(s.ended());
  assert.equal(dialog.open, false);
  dialog.deliverClose();
  assert.ok(s.ended());
});

test("a stream arriving after Cancel during the request is stopped", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  app.$("cameraBtn").click();
  app.$("cameraCancel").click();
  dialog.deliverClose();
  const late = fakeStream();
  app.calls.at(-1).resolve(late);
  await flush();
  assert.ok(late.ended());
  assert.equal(dialog.open, false);
});
