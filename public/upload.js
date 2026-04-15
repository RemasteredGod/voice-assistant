(function () {
  'use strict';

  // Extract token from URL: /upload/:token
  const token = window.location.pathname.split('/')[2] || '';

  const loading       = document.getElementById('loading');
  const errorScreen   = document.getElementById('errorScreen');
  const mainContent   = document.getElementById('mainContent');
  const ticketCard    = document.getElementById('ticketCard');
  const fileInput     = document.getElementById('fileInput');
  const selectedFiles = document.getElementById('selectedFiles');
  const selectedList  = document.getElementById('selectedList');
  const selectedHeader= document.getElementById('selectedHeader');
  const uploadBtn     = document.getElementById('uploadBtn');
  const progressBar   = document.getElementById('progressBar');
  const progressFill  = document.getElementById('progressFill');
  const alertSuccess  = document.getElementById('alertSuccess');
  const alertError    = document.getElementById('alertError');
  const uploadedFiles = document.getElementById('uploadedFiles');
  const uploadedList  = document.getElementById('uploadedList');
  const successScreen = document.getElementById('successScreen');

  let selectedFileList = [];
  let ticketData       = null;

  // ── Load ticket via token ─────────────────────────────────────────────────
  async function loadTicket() {
    try {
      const res = await fetch(`/api/upload/${token}`);
      if (res.status === 410) {
        showError('⏰ This upload link has expired. Please call DMC helpline for a new link.');
        return;
      }
      if (!res.ok) throw new Error('Not found');
      ticketData = await res.json();
      renderTicket(ticketData);
      renderUploadedFiles(ticketData.files || []);
      loading.style.display     = 'none';
      mainContent.style.display = 'block';
    } catch {
      showError('❌ Invalid or expired link. Please check the SMS sent to you.');
    }
  }

  function showError(msg) {
    loading.style.display = 'none';
    errorScreen.style.display = 'block';
    document.querySelector('#errorScreen .alert-error').textContent = msg;
  }

  function renderTicket(t) {
    const expiry = new Date(t.uploadExpiry).toLocaleString('en-US');
    ticketCard.innerHTML = `
      <div class="ticket-id">🎫 ${esc(t.id)}</div>
      <div class="ticket-row"><span class="ticket-label">Name</span><span class="ticket-value">${esc(t.name)}</span></div>
      <div class="ticket-row"><span class="ticket-label">Phone</span><span class="ticket-value">${esc(t.phone)}</span></div>
      <div class="ticket-row"><span class="ticket-label">Complaint</span><span class="ticket-value">${esc(t.complaint)}</span></div>
      <div class="ticket-row"><span class="ticket-label">Status</span><span class="ticket-value"><span class="status-badge">${esc(t.status)}</span></span></div>
      <div class="ticket-row" style="margin-top:8px"><span class="ticket-label" style="color:#f0a030">⏰ Expires</span><span class="ticket-value" style="color:#f0a030;font-size:13px">${expiry}</span></div>
    `;
  }

  function renderUploadedFiles(files) {
    if (!files.length) return;
    uploadedFiles.style.display = 'block';
    uploadedList.innerHTML = files.map(f => `
      <div class="file-item">
        <span class="file-icon">${fileIcon(f.mimeType)}</span>
        ${f.signedUrl
          ? `<a class="file-name" href="${esc(f.signedUrl)}" target="_blank" rel="noopener noreferrer">${esc(f.originalName)}</a>`
          : `<span class="file-name">${esc(f.originalName)}</span>`}
        <span class="file-status">✅</span>
      </div>
    `).join('');
  }

  // ── File selection ────────────────────────────────────────────────────────
  const uploadZone = document.getElementById('uploadZone');

  fileInput.addEventListener('change', () => {
    selectedFileList = Array.from(fileInput.files);
    renderSelected();
  });

  uploadZone.addEventListener('dragover',  (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    selectedFileList = Array.from(e.dataTransfer.files);
    renderSelected();
  });

  function renderSelected() {
    const oversized = selectedFileList.filter(f => f.size > 10 * 1024 * 1024);
    if (oversized.length) {
      alertError.textContent   = `❌ Files exceed 10MB: ${oversized.map(f => f.name).join(', ')}`;
      alertError.style.display = 'block';
      selectedFileList = selectedFileList.filter(f => f.size <= 10 * 1024 * 1024);
    }
    if (!selectedFileList.length) {
      selectedFiles.style.display = 'none';
      uploadBtn.disabled = true;
      return;
    }
    selectedFiles.style.display = 'block';
    selectedHeader.textContent  = `${selectedFileList.length} file${selectedFileList.length > 1 ? 's' : ''} selected`;
    selectedList.innerHTML = selectedFileList.map(f => `
      <div class="file-item">
        <span class="file-icon">${fileIcon(f.type)}</span>
        <span class="file-name">${esc(f.name)}</span>
        <span class="file-size">${formatSize(f.size)}</span>
      </div>
    `).join('');
    uploadBtn.disabled = false;
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  uploadBtn.addEventListener('click', async () => {
    if (!selectedFileList.length) return;
    alertSuccess.style.display = 'none';
    alertError.style.display   = 'none';
    uploadBtn.disabled = true;
    progressBar.style.display  = 'block';
    progressFill.style.width   = '0%';

    const formData = new FormData();
    selectedFileList.forEach(f => formData.append('files', f));

    try {
      let prog = 0;
      const iv = setInterval(() => {
        prog = Math.min(prog + 8, 85);
        progressFill.style.width = prog + '%';
      }, 150);

      const res = await fetch(`/api/upload/${token}`, { method: 'POST', body: formData });
      clearInterval(iv);
      progressFill.style.width = '100%';

      if (res.status === 410) throw new Error('expired');
      if (!res.ok) throw new Error('failed');

      setTimeout(() => {
        progressBar.style.display  = 'none';
        mainContent.style.display  = 'none';
        successScreen.style.display = 'block';
      }, 500);
    } catch (err) {
      progressBar.style.display = 'none';
      alertError.textContent    = err.message === 'expired'
        ? '⏰ This upload link has expired.'
        : '❌ Upload failed. Please try again.';
      alertError.style.display  = 'block';
      uploadBtn.disabled = false;
    }
  });

  // ── Utils ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  }
  function fileIcon(mime) {
    if (!mime) return '📄';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime === 'application/pdf') return '📕';
    return '📄';
  }

  loadTicket();
})();
