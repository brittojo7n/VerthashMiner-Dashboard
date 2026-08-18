"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { startServer, delay, ROOT } = require("../helpers/harness");
const { installDom } = require("../helpers/dom-stub");
const { SESSION_EXPECTED, SMI_OUTPUT } = require("../helpers/fixtures");

/**
 * Runs the real browser entry point (`public/js/app.js`) against a real server
 * over a real SSE connection, using a minimal DOM stub.
 *
 * This is the closest thing to "what the operator sees" that can be asserted
 * without a browser engine: the assertions read the text the app actually wrote
 * into the elements, not a re-implementation of it.
 *
 * `app.js` has module-level side effects (it connects on import), so it can
 * only be imported once per process — hence a single, thorough test.
 */
test("the real UI code renders the miner console into the DOM", async t => {
  const app = await startServer({ smi: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT) });
  const dom = installDom(app.origin);

  t.after(async () => {
    dom.restore();
    await app.close();
  });

  // `connection.js` uses fetch() against a relative URL; point it at the server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(new URL(url, app.origin), init);
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await app.minerManager.start();
  await import(pathToFileURL(path.join(ROOT, "public", "js", "app.js")).href);

  // Wait until the app has painted the end of the session.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = dom.logRows();
    if (rows.some(row => row.innerHTML.includes("accepted: 2/3"))) break;
    await delay(50);
  }
  await delay(150);

  /* ---- headline metrics -------------------------------------------------- */
  assert.equal(dom.textOf("hashrate"), SESSION_EXPECTED.hashrateKHs.toFixed(2));
  assert.equal(dom.textOf("accepted"), "2 / 3");
  assert.equal(dom.textOf("ratio"), "66.7%");
  assert.equal(dom.textOf("rejected"), "1");
  assert.equal(dom.textOf("difficulty"), "0.125");
  assert.equal(dom.textOf("status"), "MINING");
  assert.equal(dom.textOf("walletAddress"), "vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk");
  assert.match(dom.textOf("host"), /^Host: /);
  assert.match(dom.textOf("uptime"), /^\d{2}:\d{2}:\d{2}$/);

  /* ---- controls reflect a running miner ---------------------------------- */
  assert.equal(dom.textOf("btnAction"), "STOP");
  assert.equal(dom.nodes.get("btnAction").className, "c-btn btn-stop");
  assert.equal(dom.nodes.get("dot").className, "dot ok");
  assert.equal(dom.nodes.get("btnRestart").disabled, false);

  /* ---- console ------------------------------------------------------------ */
  const rows = dom.logRows();
  const html = rows.map(r => r.innerHTML).join("\n");

  assert.ok(rows.length > 5, `expected console rows, got ${rows.length}`);
  assert.ok(rows.length <= app.config.MAX_LOGS, "rendered rows are capped like the server buffer");
  assert.ok(html.includes("Loading verthash data file"), "boot lines rendered");
  assert.ok(html.includes("421.46"), "the newest line (final total hashrate) rendered");
  assert.ok(!html.includes('"method":"mining.submit"'), "protocol frames stay hidden");
  assert.match(dom.textOf("logCount"), /^\d+ logs?$/);

  // Duplicate suppression: no line is rendered twice across all deltas.
  const texts = rows.map(r => r.innerHTML);
  assert.equal(new Set(texts).size, texts.length, "no duplicated console rows");

  /* ---- markup safety ------------------------------------------------------ */
  for (const row of rows) {
    assert.ok(!/<script/i.test(row.innerHTML), "no script tags ever reach the console");
  }

  /* ---- GPU cards ---------------------------------------------------------- */
  const gpuHost = dom.nodes.get("gpus");
  assert.equal(gpuHost.children.length, 2, "one card per GPU");

  /* ---- error box stays hidden on a healthy session ------------------------ */
  assert.equal(dom.nodes.get("error").className, "errorbox");

  /* ---- hiding the tab must drop the stream (zero-idle contract) ----------- */
  dom.document.hidden = true;
  dom.document.listeners.get("visibilitychange")?.();
  await delay(150);
  assert.equal(app.sseHub.size, 0, "a hidden tab releases the subscription");
  assert.equal(app.gpuManager.active, false, "and stops GPU polling");
});

test("an injected log line cannot execute markup in the console", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const { createConsole } = await import(
    pathToFileURL(path.join(ROOT, "public", "js", "console.js")).href
  );
  const dom = installDom(app.origin);
  t.after(() => dom.restore());

  const view = createConsole({
    terminal: dom.document.getElementById("terminal"),
    lines: dom.document.getElementById("logLines"),
    counter: dom.document.getElementById("logCount")
  });

  view.render(
    [
      { id: 1, text: '<img src=x onerror="alert(1)">', type: "info" },
      { id: 2, text: "</span><script>alert(2)</script>", type: "error" },
      { id: 3, text: "plain & simple <b>", type: "info" }
    ],
    { count: 3, capacity: 50 }
  );

  const html = dom.logRows().map(r => r.innerHTML).join("\n");
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<[a-z]+[^>]*\son\w+=/i.test(html), "no live event-handler attribute");
  assert.ok(html.includes("&lt;img"), "the payload is shown, escaped");
  assert.ok(html.includes("&amp;"), "ampersands escaped");
});

test("delta rendering keeps the console consistent across resyncs", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const { createConsole } = await import(
    pathToFileURL(path.join(ROOT, "public", "js", "console.js")).href
  );
  const dom = installDom(app.origin);
  t.after(() => dom.restore());

  const view = createConsole({
    terminal: dom.document.getElementById("terminal"),
    lines: dom.document.getElementById("logLines"),
    counter: dom.document.getElementById("logCount")
  });

  const entry = id => ({ id, text: `line ${id}`, type: "info" });

  view.render([entry(1), entry(2)], { count: 2, capacity: 5 });
  view.render([entry(3)], { count: 3, capacity: 5 });
  // A resync replays entries the client already has.
  view.render([entry(2), entry(3), entry(4)], { count: 4, capacity: 5 });
  // A stats-only frame carries no entries and must not clear anything.
  view.render([], { count: 4, capacity: 5 });

  const rendered = dom.logRows().map(r => r.innerHTML);
  assert.equal(rendered.length, 4, "each line rendered exactly once");
  assert.ok(rendered[0].includes("line 1"));
  assert.ok(rendered[3].includes("line 4"));
  assert.equal(dom.textOf("logCount"), "4 logs");

  // Beyond capacity the oldest rows are dropped, mirroring the server buffer.
  for (let id = 5; id <= 12; id++) view.render([entry(id)], { count: 5, capacity: 5 });
  assert.ok(dom.logRows().length <= 5, `rows=${dom.logRows().length}`);
});
