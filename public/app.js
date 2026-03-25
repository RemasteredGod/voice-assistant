(function () {
  'use strict';

  const orbWrap = document.getElementById('orbWrap');
  const orb     = document.getElementById('orb');
  const pill    = document.getElementById('pill');
  const pillTxt = document.getElementById('pillTxt');
  const hint    = document.getElementById('hint');
  const msgs    = document.getElementById('msgs');
  const empty   = document.getElementById('empty');
  const liveDot = document.getElementById('liveDot');
  const msgCnt  = document.getElementById('msgCnt');
  const warning = document.getElementById('warning');

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    warning.style.display = 'block';
    hint.textContent = 'Use Chrome or Edge for voice support';
    return;
  }

  // ── State flags ───────────────────────────────────────────────────────────────
  let active     = false;   // user has started the session
  let processing = false;   // currently in AI pipeline (stop → think → speak)
  let recog      = null;
  let audio      = null;
  let total      = 0;
  const SESSION  = 'sess-' + Math.random().toString(36).slice(2, 9);

  // ── Orb ────────────────────────────────────────────────────────────────────────
  function setState(state, label) {
    orb.className     = 'orb ' + (state === 'idle' ? '' : state);
    orbWrap.className = 'orb-wrap ' + (state === 'idle' ? '' : state);
    pill.className    = 'state-pill ' + (state === 'idle' ? '' : state);
    pillTxt.textContent = label;
  }

  // ── Transcript ────────────────────────────────────────────────────────────────
  function addMsg(role, text) {
    empty.style.display = 'none';
    liveDot.classList.add('on');
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = `<span class="msg-label">${role === 'user' ? '🎤 You' : '🤖 Jarvis'}</span>${esc(text)}`;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    total++;
    msgCnt.textContent = total + ' message' + (total === 1 ? '' : 's');
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Stop mic completely ────────────────────────────────────────────────────────
  function stopMic() {
    if (recog) {
      recog.onresult = null;
      recog.onerror  = null;
      recog.onend    = null;
      try { recog.stop(); } catch (_) {}
      recog = null;
    }
  }

  // ── Speak ──────────────────────────────────────────────────────────────────────
  function speak(b64, text) {
    return new Promise((resolve) => {
      setState('speaking', 'SPEAKING');
      hint.textContent = `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`;
      hint.classList.remove('error');

      if (audio) { audio.pause(); audio = null; }
      audio = new Audio('data:audio/mp3;base64,' + b64);
      audio.onended = () => { audio = null; resolve(); };
      audio.onerror = () => { audio = null; resolve(); };
      audio.play().catch(() => resolve());
    });
  }

  // ── AI pipeline: text → Gemini → TTS → play ───────────────────────────────────
  async function chat(text) {
    setState('thinking', 'THINKING…');
    hint.textContent = 'Jarvis is thinking…';

    let data;
    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, sessionId: SESSION }),
      });
      if (!res.ok) throw new Error('Server ' + res.status);
      data = await res.json();
    } catch (err) {
      hint.textContent = 'Error: ' + err.message;
      hint.classList.add('error');
      processing = false;
      if (active) startListening();   // retry listening after error
      return;
    }

    addMsg('ai', data.reply);

    // Play audio — mic is already stopped, safe to play
    await speak(data.audioBase64, data.reply);

    // Done — unlock and go back to listening
    processing = false;
    if (active) startListening();
  }

  // ── Start listening (only if not already processing) ──────────────────────────
  function startListening() {
    if (!active || processing) return;

    setState('listening', 'LISTENING…');
    hint.textContent = 'Speak now… (pause when done)';
    hint.classList.remove('error');

    let silenceTimer   = null;
    let fullTranscript = '';

    recog = new SpeechRecognition();
    recog.lang            = 'en-IN';
    recog.continuous      = true;   // keep listening until silence timeout
    recog.interimResults  = true;   // get partial results to build full sentence
    recog.maxAlternatives = 1;

    recog.onresult = (e) => {
      // Rebuild full transcript from ALL result segments so far
      fullTranscript = '';
      for (let i = 0; i < e.results.length; i++) {
        fullTranscript += e.results[i][0].transcript;
      }

      // Show live preview in hint
      hint.textContent = `"${fullTranscript.trim()}"`;

      // Reset silence debounce — wait 1.5s of no new speech before processing
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const text = fullTranscript.trim();
        if (!text) { startListening(); return; }

        // Lock and process
        processing = true;
        stopMic();
        addMsg('user', text);
        setState('thinking', 'THINKING…');
        chat(text);
      }, 1500);
    };

    recog.onerror = (e) => {
      clearTimeout(silenceTimer);
      if (e.error === 'no-speech' || e.error === 'aborted') {
        if (active && !processing) startListening();
        return;
      }
      hint.textContent = 'Mic error: ' + e.error;
      hint.classList.add('error');
      if (active && !processing) setTimeout(startListening, 1500);
    };

    recog.onend = () => {
      clearTimeout(silenceTimer);
      // If we have accumulated text but timer fired before onend, process it
      if (active && !processing && fullTranscript.trim()) {
        const text = fullTranscript.trim();
        processing = true;
        stopMic();
        addMsg('user', text);
        setState('thinking', 'THINKING…');
        chat(text);
        return;
      }
      if (active && !processing) startListening();
    };

    try { recog.start(); } catch (_) {
      if (active && !processing) setTimeout(startListening, 500);
    }
  }

  // ── Full stop ──────────────────────────────────────────────────────────────────
  function stopAll() {
    active     = false;
    processing = false;
    stopMic();
    if (audio) { audio.pause(); audio = null; }
    setState('idle', 'TAP TO START');
    hint.textContent = 'Click the orb to talk to Jarvis';
    hint.classList.remove('error');
    liveDot.classList.remove('on');
  }

  // ── Orb click ─────────────────────────────────────────────────────────────────
  orbWrap.addEventListener('click', () => {
    if (!active) {
      active = true;
      startListening();
    } else {
      stopAll();
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────────
  setState('idle', 'TAP TO START');
})();
