"use strict";
// One camera request at a time. A stream that arrives after close(), or for an
// older request, has all of its tracks stopped immediately.
(function (root) {
  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  function createCamera(getUserMedia) {
    let session = 0;
    let pending = false;
    let stream = null;
    return {
      get pending() { return pending; },
      get stream() { return stream; },
      async open(constraints) {
        if (pending || stream) return { status: "ignored" };
        const id = ++session;
        pending = true;
        let result;
        try {
          result = await getUserMedia(constraints);
        } catch (error) {
          if (id !== session) return { status: "stale" };
          pending = false;
          return { status: "error", error };
        }
        if (id !== session) {
          stopTracks(result);
          return { status: "stale" };
        }
        pending = false;
        stream = result;
        return { status: "open", stream: result };
      },
      close() {
        session++;
        pending = false;
        stopTracks(stream);
        stream = null;
      },
    };
  }

  const api = { createCamera, stopTracks };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FindItCamera = api;
})(typeof window !== "undefined" ? window : globalThis);
