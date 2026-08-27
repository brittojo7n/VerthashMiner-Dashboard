"use strict";
module.exports = { unrefTimer: (fn, ms) => { const h = setTimeout(fn, ms); if (typeof h.unref === "function") h.unref(); return h; } };
