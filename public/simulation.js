(function () {
  'use strict';

  // ── DOM ──────────────────────────────────────────────────────────────────────
  const phoneInput    = document.getElementById('phone-input');
  const callBtn       = document.getElementById('call-btn');
  const callBtnIcon   = document.getElementById('call-btn-icon');
  const callBtnText   = document.getElementById('call-btn-text');
  const statusText    = document.getElementById('status-text');
  const callSidEl     = document.getElementById('call-sid-display');
  const durationEl    = document.getElementById('duration-display');
  const transcriptBody= document.getElementById('transcript-body');
  const emptyState    = document.getElementById('empty-state');
  const clearBtn      = document.getElementById('clear-btn');
  const statusConn    = document.getElementById('status-conn');
  const msgCountEl    = document.getElementById('msg-count');
  const liveBadge     = document.getElementById('live-badge');
  const agentAvatar   = document.getElementById('agent-avatar');
  const statusDot     = document.getElementById('status-dot');
  const statusLabel   = document.getElementById('status-label');

  // ── State ────────────────────────────────────────────────────────────────────
  let callActive  = false;
  let callSid     = null;
  let startTime   = null;
  let durationInt = null;
  let msgTotal    = 0;

  // ── Agent state ───────────────────────────────────────────────────────────────
  function setAgentState(state) {
    // state: 'idle' | 'ringing' | 'listening' | 'speaking' | 'ended'
    agentAvatar.className = 'agent-avatar' + (state !== 'idle' && state !== 'ended' ? ' ' + state : '');
    statusDot.className = 'status-dot';
    const labels = {
      idle:      ['', 'Idle'],
      ringing:   ['orange', 'Ringing…'],
      listening: ['green', 'Listening'],
      speaking:  ['green', 'Speaking'],
      ended:     ['red', 'Call Ended'],
    };
    const [dotClass, label] = labels[state] || labels.idle;
    if (dotClass) statusDot.classList.add(dotClass);
    statusLabel.textContent = label;
  }

  // ── Transcript ────────────────────────────────────────────────────────────────
  function addMessage(role, text) {
    if (emptyState) emptyState.style.display = 'none';

    const isAI = role === 'ai';
    const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    const row = document.createElement('div');
    row.className = 'msg-row' + (isAI ? '' : ' caller');

    row.innerHTML = `
      <div class="msg-avatar ${isAI ? 'ai' : 'caller'}">${isAI ? '🤖' : '🎤'}</div>
      <div>
        <div class="bubble ${isAI ? 'ai' : 'caller'}">${escHtml(text)}</div>
        <div class="bubble-meta">${isAI ? 'Samadhan AI' : 'Caller'} · ${now}</div>
      </div>
    `;

    transcriptBody.appendChild(row);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    msgTotal++;
    msgCountEl.textContent = msgTotal;
  }

  function addSysEvent(text) {
    if (emptyState) emptyState.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'sys-event';
    div.textContent = text;
    transcriptBody.appendChild(div);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  clearBtn.addEventListener('click', () => {
    transcriptBody.innerHTML = '';
    const fresh = document.createElement('div');
    fresh.className = 'empty-state';
    fresh.id = 'empty-state';
    fresh.innerHTML = '<div class="empty-icon">💬</div><p class="ui-text" style="font-weight:600;color:var(--color-navy);">Transcript cleared</p>';
    transcriptBody.appendChild(fresh);
    msgTotal = 0;
    msgCountEl.textContent = '0';
  });

  // ── SSE ───────────────────────────────────────────────────────────────────────
  function connectSSE() {
    const es = new EventSource('/api/transcripts');

    es.onopen = () => {
      statusConn.textContent = '● Connected';
      statusConn.style.color = '#4ade80';
    };

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'connected') return;

        if (event.type === 'user') {
          addMessage('user', event.text);
          setStatus('Caller spoke — Samadhan is thinking…');
          setAgentState('listening');
        } else if (event.type === 'ai') {
          addMessage('ai', event.text);
          setStatus('Samadhan is speaking…');
          setAgentState('speaking');
          setTimeout(() => { if (callActive) setAgentState('listening'); }, 2500);
        } else if (event.type === 'call_started') {
          onCallConnected(event.callSid);
        } else if (event.type === 'call_ended') {
          onCallEnded();
        }
      } catch (_) {}
    };

    es.onerror = () => {
      statusConn.textContent = '● Reconnecting…';
      statusConn.style.color = '#f59e0b';
      setTimeout(connectSSE, 3000);
      es.close();
    };
  }

  connectSSE();

  // ── Call flow ─────────────────────────────────────────────────────────────────
  callBtn.addEventListener('click', async () => {
    if (callActive) { await endCall(); } else { await startCall(); }
  });

  async function startCall() {
    const number = phoneInput.value.trim();
    if (!number) { setStatus('Enter a phone number first'); phoneInput.focus(); return; }

    callBtn.disabled  = true;
    callBtnIcon.textContent = '⏳';
    callBtnText.textContent = 'Initiating…';
    setStatus('Placing call via Twilio…');
    setAgentState('ringing');

    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch('/api/call', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ to: number }),
          signal:  controller.signal,
        });
      } finally { clearTimeout(timeout); }

      let data = {};
      try { data = await res.json(); } catch { data = { error: `Server returned ${res.status}` }; }
      if (!res.ok) throw new Error(data.error || 'Call failed');

      callSid    = data.callSid;
      callActive = true;
      callSidEl.textContent = data.callSid || '—';

      callBtn.disabled = false;
      callBtn.className = 'btn-call end';
      callBtnIcon.textContent = '📵';
      callBtnText.textContent = 'End Call';
      phoneInput.disabled = true;
      liveBadge.style.visibility = 'visible';

      addSysEvent(`📞 Call initiated to ${number}`);
      setStatus(`Ringing ${number}… waiting for answer`);

      startTime   = Date.now();
      durationInt = setInterval(() => {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        durationEl.textContent = `${m}:${s}`;
      }, 1000);

    } catch (err) {
      callBtn.disabled = false;
      callBtn.className = 'btn-call start';
      callBtnIcon.textContent = '📞';
      callBtnText.textContent = 'Start Call';
      setAgentState('idle');
      const msg = err.name === 'AbortError' ? 'Timed out — server not responding' : err.message;
      setStatus('⚠ ' + msg);
    }
  }

  async function endCall() {
    if (!callSid) { resetCallUI(); return; }
    setStatus('Ending call…');
    try {
      await fetch('/api/call/end', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callSid }),
      });
    } catch (_) {}
    onCallEnded();
  }

  function onCallConnected(sid) {
    setStatus('Call connected — Samadhan is listening');
    if (sid) callSidEl.textContent = sid;
    setAgentState('listening');
    addSysEvent('✅ Call connected');
  }

  function onCallEnded() {
    callActive = false;
    clearInterval(durationInt);
    setAgentState('ended');
    addSysEvent('📵 Call ended');
    liveBadge.style.visibility = 'hidden';
    resetCallUI();
    setStatus('Call ended');
  }

  function resetCallUI() {
    callBtn.disabled    = false;
    callBtn.className   = 'btn-call start';
    callBtnIcon.textContent = '📞';
    callBtnText.textContent = 'Start Call';
    phoneInput.disabled = false;
    callSid             = null;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  setAgentState('idle');
  phoneInput.focus();
})();
