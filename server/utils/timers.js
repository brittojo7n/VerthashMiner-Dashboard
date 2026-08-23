"use strict";

function unrefTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

module.exports = { unrefTimer };
