"use strict";
// Maps a search query to COCO classes by exact match only: the full class name
// (English or Korean) or a listed synonym. No prefix or partial matching, so an
// unsupported object ("tablet", "phone case") is never turned into another class.
(function (root) {
  const normalize = (text) => String(text).trim().toLowerCase().replace(/\s+/g, " ");

  // Returns null for an empty query, otherwise the set of classes it names (may be empty).
  function queryClasses(query, classes, koNames, synonyms) {
    const q = normalize(query);
    if (!q) return null;
    const out = new Set();
    for (const name of classes) {
      if (normalize(name) === q || normalize(koNames[name] || "") === q) out.add(name);
    }
    if (Object.prototype.hasOwnProperty.call(synonyms, q)) out.add(synonyms[q]);
    return out;
  }

  const api = { queryClasses, normalize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FindItSearch = api;
})(typeof window !== "undefined" ? window : globalThis);
