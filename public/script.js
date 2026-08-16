(() => {
  const el = id => document.getElementById(id);
  const setText = (id, val) => { const node = el(id); if (node && node.textContent !== String(val)) node.textContent = val; };
  const setHtml = (id, val) => { const node = el(id); if (node && node.innerHTML !== String(val)) node.innerHTML = val; };
  const fmt = (v, digits = 1) => v == null || !Number.isFinite(v) ? "—" : Number(v).toFixed(digits);

  const fmtUptime = s => {
    s = Math.max(0, Math.floor(s || 0));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return d > 0 ? `${d}d ${h}h ${m}m` : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const tempClass = t => t == null ? "" : t >= 80 ? "red" : t >= 72 ? "yellow" : "green";

  const authModal = el("authModal");
  const authInput = el("authInput");
  const authError = el("authError");
  const authSubmit = el("authSubmit");

  const hostEl = el("host");
  const statusEl = el("status");
  const dotEl = el("dot");
  const btnAction = el("btnAction");
  const btnRestart = el("btnRestart");
  const hashrateEl = el("hashrate");
  const acceptedEl = el("accepted");
  const ratioEl = el("ratio");
  const uptimeEl = el("uptime");
  const rejectedEl = el("rejected");
  const sharesPerMinuteEl = el("sharesPerMinute");
  const difficultyEl = el("difficulty");
  const lastAcceptedEl = el("lastAccepted");
  const errorEl = el("error");
  const gpusBox = el("gpus");
  const walletEl = el("walletAddress");
  const localTimeEl = el("localTime");

  const terminal = el("terminal");
  const logLinesEl = el("logLines");
  const logCountEl = el("logCount");
  const btnAutoScroll = el("btnAutoScroll");
  const btnCopyLogs = el("btnCopyLogs");

  let autoScroll = true, logsList = [], lastRenderedLogId = null;
  let serverStartedAt = null, serverNowBase = null, serverNowCapturedAt = null, serverTz = null;
  let tickInterval = null, spmInterval = null, latestAccepted = 0;
  let pendingStatus = null, activeAction = null;

  const IDLE = { STOPPED: 1, CRASHED: 1, ERROR: 1 };
  const LIVE = { MINING: 1, CONNECTED: 1, WAITING: 1 };
  const ACTION_STATUS = { start: "STARTING", stop: "STOPPING", restart: "RESTARTING" };

  const applyChrome = (status, locked) => {
    setText("status", status);
    const idle = !!IDLE[status];
    const live = !!LIVE[status];
    const busy = locked || (!idle && !live);
    const dot = idle ? "err" : (status === "MINING" || status === "CONNECTED") ? "ok" : "warn";
    if (dotEl.className !== "dot " + dot) dotEl.className = "dot " + dot;
    setText("btnAction", idle ? "START" : "STOP");
    const cls = "c-btn " + (idle ? "btn-start" : "btn-stop");
    if (btnAction.className !== cls) btnAction.className = cls;
    btnAction.disabled = busy;
    btnRestart.disabled = busy || idle;
  };

  const resolveStatus = s => {
    if (pendingStatus) return pendingStatus;
    const st = s.mining.status;
    return (!s.miner.running && LIVE[st]) ? "STOPPED" : st;
  };

  btnAutoScroll.onclick = () => {
    autoScroll = !autoScroll;
    btnAutoScroll.className = "c-btn " + (autoScroll ? "active" : "");
    btnAutoScroll.textContent = "Auto-scroll: " + (autoScroll ? "ON" : "OFF");
    if (autoScroll) scrollToBottom();
  };

  terminal.addEventListener("scroll", () => {
    const isAtBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 25;
    if (isAtBottom !== autoScroll) {
      autoScroll = isAtBottom;
      btnAutoScroll.className = "c-btn " + (autoScroll ? "active" : "");
      btnAutoScroll.textContent = "Auto-scroll: " + (autoScroll ? "ON" : "OFF");
    }
  }, { passive: true });

  const scrollToBottom = () => {
    requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
  };

  btnCopyLogs.onclick = async () => {
    if (!logsList.length) return;
    const text = logsList.map(l => `> ${l.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      const prev = btnCopyLogs.textContent;
      btnCopyLogs.textContent = "Copied!";
      setTimeout(() => { btnCopyLogs.textContent = prev; }, 1200);
    } catch { }
  };

  const escapeHtml = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const highlightSyntax = rawText => {
    let text = escapeHtml(rawText);
    return text
      .replace(/(\b[\d.]+\s*(?:kH|MH|GH|TH)\/s\b)/gi, '<span class="hl-hash">$1</span>')
      .replace(/(\baccepted:\s*\d+\s*\/\s*\d+(?:\s*\([\d.]*%\))?)/gi, '<span class="hl-acc">$1</span>')
      .replace(/(\bdifficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*[\d.]+\b)/gi, '<span class="hl-diff">$1</span>')
      .replace(/(\b(?:errors?|err):\s*0\b)/gi, '<span class="hl-acc">$1</span>')
      .replace(/(\bwarnings?:\s*0\b)/gi, '<span class="hl-acc">$1</span>')
      .replace(/(\b(?:errors?|err):\s*[1-9]\d*\b)/gi, '<span class="hl-err">$1</span>')
      .replace(/(\b(?:cuda\s+error|fatal\s+error|connection\s+failed|connection\s+refused|out\s+of\s+memory|failed\s+to\s+\w+|exception|enoent|rejected\s+share)\b[^\n<]*)/gi, '<span class="hl-err">$1</span>')
      .replace(/\b(INFO)\b/g, '<span class="hl-info">$1</span>')
      .replace(/\b(DEBUG)\b/g, '<span class="hl-debug">$1</span>')
      .replace(/\b(WARN(?:ING)?)\b/g, '<span class="hl-warn">$1</span>')
      .replace(/\b(ERROR|FATAL)\b/g, '<span class="hl-err">$1</span>')
      .replace(/^(\[(?:SYSTEM|WARN|ERROR|INFO|DEBUG)\])/g, '<span class="hl-tag">$1</span>');
  };

  const renderLogs = logs => {
    if (!logs || !logs.length) {
      logLinesEl.innerHTML = '<div class="log-empty"><span class="log-prompt">&gt;</span><span class="log-text">VerthashMiner console active. Waiting for miner output...</span><span class="term-cursor">_</span></div>';
      logLinesEl.dataset.maxId = 0;
      setText("logCount", "0 logs");
      return;
    }

    setText("logCount", `${logs.length} log${logs.length === 1 ? '' : 's'}`);
    
    if (logLinesEl.querySelector('.log-empty')) {
      logLinesEl.innerHTML = "";
    }

    const fragment = document.createDocumentFragment();
    let maxRenderedId = parseInt(logLinesEl.dataset.maxId || "0", 10);
    let added = 0;

    for (let i = 0; i < logs.length; i++) {
      const l = logs[i];
      if (l.id > maxRenderedId) {
        const div = document.createElement("div");
        div.className = `log-entry log-type-${l.type || 'info'}`;
        div.dataset.id = l.id;
        div.innerHTML = `<span class="log-prompt">&gt;</span><span class="log-msg">${highlightSyntax(l.text)}</span>`;
        fragment.appendChild(div);
        maxRenderedId = l.id;
        added++;
      }
    }

    if (added > 0) {
      logLinesEl.appendChild(fragment);
      logLinesEl.dataset.maxId = maxRenderedId;
      while (logLinesEl.children.length > logs.length) {
        logLinesEl.removeChild(logLinesEl.firstChild);
      }
      if (autoScroll) scrollToBottom();
    }
  };

  const fmtDate = ms => {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const fmtServerTime = (ms, tz) => {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz ? ` (${tz})` : ""}`;
  };

  const tickServerTime = () => {
    if (serverNowBase == null) return;
    const elapsed = Date.now() - serverNowCapturedAt;
    localTimeEl.textContent = fmtServerTime(serverNowBase + elapsed, serverTz);
  };

  const tickUptime = () => {
    if (serverNowBase == null) return;
    const serverNow = serverNowBase + (Date.now() - serverNowCapturedAt);
    const elapsed = Math.floor((serverNow - serverStartedAt) / 1000);
    setText("uptime", fmtUptime(elapsed));
  };

  const tickSpm = () => {
    if (serverStartedAt == null || serverNowBase == null) return;
    const serverNow = serverNowBase + (Date.now() - serverNowCapturedAt);
    const uptimeMin = (serverNow - serverStartedAt) / 60000;
    const spm = uptimeMin > 0 ? latestAccepted / uptimeMin : latestAccepted;
    sharesPerMinuteEl.textContent = spm > 0 ? fmt(spm, 3) : "—";
  };

  const startTicking = () => {
    if (!tickInterval) {
      tickInterval = setInterval(() => { tickServerTime(); tickUptime(); }, 1000);
    }
    if (!spmInterval) {
      spmInterval = setInterval(tickSpm, 2000);
    }
  };

  const stopTicking = () => {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    if (spmInterval) {
      clearInterval(spmInterval);
      spmInterval = null;
    }
  };

  const render = s => {
    serverNowBase = s.now;
    serverNowCapturedAt = Date.now();
    serverStartedAt = s.startedAt;
    serverTz = s.host.tz;
    latestAccepted = s.mining.accepted;
    tickServerTime();
    tickUptime();
    if (sharesPerMinuteEl.textContent === "—" && latestAccepted > 0) tickSpm();

    setText("host", `Host: ${s.host.hostname}`);
    applyChrome(resolveStatus(s), !!pendingStatus);

    setHtml("hashrate", `${fmt(s.mining.hashrateKHs, 2)}<span class="unit">kH/s</span>`);
    setText("accepted", s.mining.submitted === 0 ? "—" : `${s.mining.accepted} / ${s.mining.submitted}`);
    setText("ratio", s.acceptedRatio == null ? "—" : `${fmt(s.acceptedRatio, 1)}%`);

    setText("rejected", s.mining.rejected);
    setText("difficulty", s.mining.difficulty == null ? "—" : s.mining.difficulty);
    setText("lastAccepted", s.mining.lastAcceptedAt ? fmtDate(s.mining.lastAcceptedAt) : "—");
    setText("walletAddress", s.miner.wallet || "—");

    if (s.miner.logs && Array.isArray(s.miner.logs)) {
      if (s.miner.logs.length > 0) {
        const latestId = s.miner.logs[s.miner.logs.length - 1].id;
        if (latestId !== lastRenderedLogId) {
          logsList = s.miner.logs;
          lastRenderedLogId = latestId;
          renderLogs(logsList);
        }
      } else if (lastRenderedLogId !== null) {
        logsList = [];
        lastRenderedLogId = null;
        renderLogs(logsList);
      }
    }

    if (s.miner.lastError) {
      errorEl.className = "errorbox show";
      errorEl.textContent = `CRITICAL ERROR: ${s.miner.lastError}`;
    } else {
      errorEl.className = "errorbox";
    }

    const gpus = s.gpu || [];
    if (gpus.length === 0) {
      gpusBox.innerHTML = '<div class="small gpu-empty">Waiting for GPU telemetry data...</div>';
      return;
    }

    if (gpusBox.children.length !== gpus.length || !el("gpu-0-temp")) {
      let html = "";
      for (const gpu of gpus) {
        html += `
    <div class="gpu-panel">
      <div class="gpu-head">
        <div class="gpu-name">GPU ${gpu.index} • <span id="gpu-${gpu.index}-name"></span></div>
      </div>
      <div class="metrics mt-0">
        <div class="metric"><div class="label">P-State</div><div class="mvalue" style="color: #4facfe;" id="gpu-${gpu.index}-pstate"></div></div>
        <div class="metric"><div class="label">GPU Temp</div><div class="mvalue" id="gpu-${gpu.index}-temp"></div></div>
        <div class="metric"><div class="label">Power</div><div class="mvalue"><span id="gpu-${gpu.index}-power"></span> <span class="unit">W</span></div></div>
        <div class="metric"><div class="label">Core Clock</div><div class="mvalue"><span id="gpu-${gpu.index}-core"></span> <span class="unit">MHz</span></div></div>
        <div class="metric"><div class="label">Memory Clock</div><div class="mvalue"><span id="gpu-${gpu.index}-mem"></span> <span class="unit">MHz</span></div></div>
        <div class="metric"><div class="label">VRAM</div><div class="mvalue" style="font-size: 15px;"><span id="gpu-${gpu.index}-vram-used"></span> <span class="unit">/ <span id="gpu-${gpu.index}-vram-total"></span> MB</span></div></div>
        <div class="metric"><div class="label">Hashrate</div><div class="mvalue gradient-text"><span id="gpu-${gpu.index}-hashrate">—</span> <span class="unit">kH/s</span></div></div>
        <div class="metric"><div class="label">Efficiency</div><div class="mvalue"><span id="gpu-${gpu.index}-eff">—</span> <span class="unit">kH/s/W</span></div></div>
      </div>
      <div class="metric metric-util">
        <div class="flex-between-end">
          <div class="label m-0">Compute Utilization</div>
          <div class="mvalue mvalue-sm m-0"><span id="gpu-${gpu.index}-util"></span>%</div>
        </div>
        <div class="bar-bg"><div class="bar-fill" id="gpu-${gpu.index}-bar"></div></div>
      </div>
    </div>`;
      }
      gpusBox.innerHTML = html;
    }

    for (const gpu of gpus) {
      const idx = gpu.index;
      setText(`gpu-${idx}-name`, gpu.name || "Unknown");
      setText(`gpu-${idx}-pstate`, gpu.pstate || "—");
      setText(`gpu-${idx}-hashrate`, gpu.hashrate != null ? fmt(gpu.hashrate, 2) : "—");

      const tempEl = el(`gpu-${idx}-temp`);
      setText(`gpu-${idx}-temp`, gpu.temperatureC != null ? `${fmt(gpu.temperatureC, 0)}°C` : "—");
      const tc = `mvalue ${tempClass(gpu.temperatureC)}`;
      if (tempEl.className !== tc) tempEl.className = tc;

      setText(`gpu-${idx}-power`, gpu.powerW != null ? fmt(gpu.powerW, 1) : "—");
      setText(`gpu-${idx}-core`, gpu.coreMHz != null ? fmt(gpu.coreMHz, 0) : "—");
      setText(`gpu-${idx}-mem`, gpu.memoryMHz != null ? fmt(gpu.memoryMHz, 0) : "—");
      setText(`gpu-${idx}-util`, gpu.utilizationPct != null ? fmt(gpu.utilizationPct, 1) : "—");

      const safeUtil = gpu.utilizationPct == null ? 0 : Math.max(0, Math.min(100, gpu.utilizationPct));
      const w = `${safeUtil}%`;
      const bar = el(`gpu-${idx}-bar`);
      if (bar.style.width !== w) bar.style.width = w;

      setText(`gpu-${idx}-vram-used`, gpu.memoryUsedMB != null ? fmt(gpu.memoryUsedMB, 0) : "—");
      setText(`gpu-${idx}-vram-total`, gpu.memoryTotalMB != null ? fmt(gpu.memoryTotalMB, 0) : "—");

      const eff = (gpu.hashrate > 0 && gpu.powerW > 0) ? (gpu.hashrate / gpu.powerW) : null;
      setText(`gpu-${idx}-eff`, eff != null ? fmt(eff, 2) : "—");
    }
  };


  const showAuthModal = () => {
    authModal.classList.add("show");
    authInput.value = "";
    authInput.focus();
  };

  const hideAuthModal = () => {
    authModal.classList.remove("show");
    authError.style.display = "none";
  };

  const doLogin = async () => {
    const passphrase = authInput.value;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase })
      });
      if (res.ok) {
        hideAuthModal();
        connectSSE();
      } else {
        authError.style.display = "block";
      }
    } catch {
      authError.style.display = "block";
    }
  };

  authSubmit.addEventListener("click", doLogin);
  authInput.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  let es = null;

  const connectSSE = () => {
    if (es) { es.close(); es = null; }
    const eventsUrl = "/events";
    es = new EventSource(eventsUrl);

    es.addEventListener("stats", event => {
      try {
        startTicking();
        render(JSON.parse(event.data));
      } catch { }
    });

    es.onerror = async () => {
      stopTicking();
      pendingStatus = null;
      if (es && es.readyState === EventSource.CLOSED) {
        try {
          const res = await fetch("/api/status");
          if (res.status === 401) {
            showAuthModal();
            return;
          }
        } catch { }
      }
      statusEl.textContent = "OFFLINE";
      dotEl.className = "dot err";
      hostEl.textContent = "Host Unreachable";
      btnAction.disabled = true;
      btnRestart.disabled = true;
    };
  };

  const init = async () => {
    try {
      const res = await fetch("/api/status");
      if (res.status === 401) {
        showAuthModal();
      } else if (res.ok) {
        if (!document.hidden) {
          connectSSE();
        }
      }
    } catch {
      setTimeout(init, 5000);
    }
  };
  init();

  const confirmModal = el("confirmModal");
  const confirmTitle = el("confirmTitle");
  const confirmDesc = el("confirmDesc");
  const confirmYes = el("confirmYes");
  const confirmCancel = el("confirmCancel");

  const hideConfirm = () => {
    confirmModal.classList.remove("show");
    activeAction = null;
  };

  confirmCancel.addEventListener("click", hideConfirm);

  const runAction = async action => {
    const next = ACTION_STATUS[action];
    if (!next || pendingStatus) return;
    pendingStatus = next;
    applyChrome(next, true);
    try {
      const res = await fetch(`/api/miner/${action}`, { method: "POST" });
      if (res.status === 401) showAuthModal();
    } catch { }
    pendingStatus = null;
  };

  confirmYes.addEventListener("click", () => {
    const action = activeAction;
    hideConfirm();
    if (action) runAction(action);
  });

  const promptAction = (action, actionName) => {
    if (pendingStatus) return;
    activeAction = action;
    confirmTitle.textContent = actionName;
    confirmDesc.textContent = `Do you want to ${actionName.toLowerCase()} the miner process?`;
    confirmYes.className = `auth-btn auth-btn-${action}`;
    confirmYes.textContent = actionName;
    confirmModal.classList.add("show");
  };

  btnAction.addEventListener("click", () => {
    const isStart = btnAction.textContent === "START";
    promptAction(isStart ? "start" : "stop", isStart ? "START" : "STOP");
  });

  btnRestart.addEventListener("click", () => {
    promptAction("restart", "RESTART");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTicking();
      if (es) {
        es.close();
        es = null;
      }
    } else {
      startTicking();
      if (!es || es.readyState === EventSource.CLOSED) connectSSE();
    }
  });
})();
