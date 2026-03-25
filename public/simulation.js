(function () {
  'use strict';

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const orb           = document.getElementById('orb');
  const orbWrapper    = orb.closest('.orb-wrapper');
  const stateBadge    = document.getElementById('state-badge');
  const stateText     = document.getElementById('state-text');
  const phoneInput    = document.getElementById('phone-input');
  const callBtn       = document.getElementById('call-btn');
  const statusPulse   = document.getElementById('status-pulse');
  const statusText    = document.getElementById('status-text');
  const callSidEl     = document.getElementById('call-sid-display');
  const durationEl    = document.getElementById('duration-display');
  const liveDot       = document.getElementById('live-dot');
  const transcriptBody= document.getElementById('transcript-body');
  const transcriptEmpty= document.getElementById('transcript-empty');
  const clearBtn      = document.getElementById('clear-btn');
  const statusConn    = document.getElementById('status-conn');
  const msgCount      = document.getElementById('msg-count');

  // ── State ────────────────────────────────────────────────────────────────────
  let callActive  = false;
  let callSid     = null;
  let startTime   = null;
  let durationInt = null;
  let msgTotal    = 0;

  // ── Orb states ───────────────────────────────────────────────────────────────
  function setOrbState(state) {
    const labels = { idle: 'IDLE', listening: 'LISTENING…', thinking: 'THINKING…', speaking: 'SPEAKING' };
    orb.className        = 'orb ' + state;
    orbWrapper.className = 'orb-wrapper ' + state;
    stateBadge.className = 'state-badge ' + state;
    stateText.textContent = labels[state] || state.toUpperCase();
  }

  // ── Transcript helpers ────────────────────────────────────────────────────────
  function addMessage(role, text) {
    if (transcriptEmpty) transcriptEmpty.style.display = 'none';
    const div = document.createElement('div');
    div.className = role === 'user' ? 'msg msg-user' : 'msg msg-ai';
    div.innerHTML = `<span class="msg-label">${role === 'user' ? '🎤 Caller' : '🤖 Jarvis'}</span>${escapeHtml(text)}`;
    transcriptBody.appendChild(div);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    msgTotal++;
    msgCount.textContent = `Messages: ${msgTotal}`;
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  clearBtn.addEventListener('click', () => {
    transcriptBody.innerHTML = '<div class="transcript-empty">Transcript cleared…</div>';
  });

  // ── SSE — live transcripts from the active call ────────────────────────────
  function connectSSE() {
    const es = new EventSource('/api/transcripts');

    es.onopen = () => {
      statusConn.textContent = '● Connected';
      statusConn.style.color = '#22c55e';
    };

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'connected') return;

        if (event.type === 'user') {
          addMessage('user', event.text);
          if (callActive) setOrbState('thinking');
        } else if (event.type === 'ai') {
          addMessage('ai', event.text);
          if (callActive) setOrbState('speaking');
          setTimeout(() => { if (callActive) setOrbState('listening'); }, 2500);
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
    if (callActive) {
      await endCall();
    } else {
      await startCall();
    }
  });

  async function startCall() {
    const number = phoneInput.value.trim();
    if (!number) {
      setStatus('ringing', 'Enter a phone number first');
      phoneInput.focus();
      return;
    }

    callBtn.disabled = true;
    callBtn.textContent = '⏳  Initiating…';
    setStatus('ringing', 'Placing call via Exotel…');
    setOrbState('thinking');

    try {
      const res = await fetch('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: number }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Call failed');

      callSid = data.callSid;
      callActive = true;
      callSidEl.textContent = `SID: ${callSid}`;

      callBtn.disabled = false;
      callBtn.textContent = '📵  End Call';
      callBtn.className = 'btn-call calling';
      phoneInput.disabled = true;

      setStatus('ringing', `Ringing ${number}… waiting for answer`);
      setOrbState('listening');
      liveDot.classList.add('active');

      startTime = Date.now();
      durationInt = setInterval(() => {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        durationEl.textContent = `⏱ ${m}:${s}`;
      }, 1000);

    } catch (err) {
      callBtn.disabled = false;
      callBtn.textContent = '📞 \u00a0Call Now';
      setStatus('ended', 'Error: ' + err.message);
      setOrbState('idle');
    }
  }

  async function endCall() {
    if (!callSid) { resetCallUI(); return; }
    setStatus('ended', 'Ending call…');
    try {
      await fetch('/api/call/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callSid }),
      });
    } catch (_) {}
    onCallEnded();
  }

  function onCallConnected(sid) {
    setStatus('connected', 'Call connected — Jarvis is listening');
    if (sid) callSidEl.textContent = `SID: ${sid}`;
  }

  function onCallEnded() {
    callActive = false;
    clearInterval(durationInt);
    resetCallUI();
    setStatus('ended', 'Call ended');
    setOrbState('idle');
    liveDot.classList.remove('active');
  }

  function resetCallUI() {
    callBtn.disabled     = false;
    callBtn.textContent  = '📞 \u00a0Call Now';
    callBtn.className    = 'btn-call';
    phoneInput.disabled  = false;
    callSid              = null;
  }

  function setStatus(state, text) {
    statusPulse.className = 'status-pulse ' + state;
    statusText.textContent = text;
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  setOrbState('idle');
  phoneInput.focus();
})();
