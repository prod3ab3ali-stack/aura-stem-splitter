// --- Global State ---
let authToken = localStorage.getItem('aura_token');
let currentUser = null;
let currentTheme = localStorage.getItem('aura_theme') || 'dark';

// --- API ---
const API_BASE = '/api';

// --- UI Elements ---
const wsLoad = document.getElementById('ws-loading');
const wsDrop = document.getElementById('ws-drop');
const wsMixer = document.getElementById('ws-mixer');
const authSidebar = document.getElementById('auth-sidebar');
const toastContainer = document.getElementById('toast-container') || createToastContainer();

function createToastContainer() {
    const d = document.createElement('div');
    d.id = 'toast-container';
    document.body.appendChild(d);
    return d;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(currentTheme);
    initHeroVisuals();
    initScrollObs();
    initDemoPlayer();

    // Simulate initial loading
    setTimeout(() => {
        const loader = document.getElementById('loader-curtain');
        if (loader) loader.style.opacity = '0';
        setTimeout(() => loader?.remove(), 500);
    }, 800);

    // 1. Recover Session
    await fetchUser(); // Get user & credits

    // 2. Check for Active Job (Persistence)
    const activeJobId = localStorage.getItem('active_stem_job');
    if (activeJobId) {
        console.log("Recovering job:", activeJobId);
        startJobPolling(activeJobId);
    }

    // 3. Init Dashboard
    if (currentUser) {
        updateDashboard();
    }
});

function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('aura_theme', mode);
}

function setTheme(mode) {
    currentTheme = mode;
    applyTheme(mode);
}

function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerText = msg;
    toastContainer.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 300);
    }, 3000);
}

// --- Auth Logic ---
async function fetchUser() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/users/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            currentUser = await res.json();
            updateUI(currentUser);
            // Switch to App View
            document.getElementById('view-landing').classList.remove('active');
            document.getElementById('view-app').classList.remove('hidden');
            document.getElementById('view-app').classList.add('active');
            updateDashboard();
        } else {
            console.warn("Session invalid");
            localStorage.removeItem('aura_token');
        }
    } catch (e) {
        console.error(e);
    }
}

function openAuth() {
    document.getElementById('auth-shade').style.display = 'block';
    authSidebar.classList.add('open');
}

function closeAuth() {
    document.getElementById('auth-shade').style.display = 'none';
    authSidebar.classList.remove('open');
}

function logout() {
    localStorage.removeItem('aura_token');
    location.reload();
}

async function handleAuth(e) {
    e.preventDefault();
    const isRegister = document.getElementById('auth-email-group').style.display !== 'none';
    const user = document.getElementById('auth-user').value;
    const pass = document.getElementById('auth-pass').value;

    const endpoint = isRegister ? '/register' : '/token';
    const payload = isRegister ?
        new URLSearchParams({ username: user, password: pass }) :
        new URLSearchParams({ username: user, password: pass });

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: payload
        });
        const data = await res.json();

        if (res.ok) {
            if (isRegister) {
                showToast("Account created! Please login.");
                toggleAuthMode();
            } else {
                authToken = data.access_token;
                localStorage.setItem('aura_token', authToken);
                closeAuth();
                fetchUser();
                showToast("Welcome back!");
            }
        } else {
            showToast(data.detail || "Error");
        }
    } catch (err) {
        showToast("Network Error");
    }
}

function toggleAuthMode() {
    const isLogin = document.getElementById('auth-title').innerText === 'Welcome';
    document.getElementById('auth-title').innerText = isLogin ? 'Create Account' : 'Welcome';
    document.getElementById('auth-email-group').style.display = isLogin ? 'none' : 'none'; // Email optional / unused for now
    document.getElementById('auth-submit').innerText = isLogin ? 'Sign Up' : 'Login';
    document.getElementById('auth-toggle-text').innerHTML = isLogin ?
        'Already have an account? <span onclick="toggleAuthMode()">Login</span>' :
        'New here? <span onclick="toggleAuthMode()">Create Account</span>';
}

document.getElementById('auth-form').onsubmit = handleAuth;


// --- Workspace Logic ---

function switchView(viewName) {
    if (viewName === 'app') {
        if (!currentUser) return openAuth();
        document.getElementById('view-landing').classList.remove('active');
        document.getElementById('view-app').classList.remove('hidden');
        document.getElementById('view-app').classList.add('active');
        updateDashboard();
    } else {
        document.getElementById('view-app').classList.remove('active');
        document.getElementById('view-app').classList.add('hidden');
        document.getElementById('view-landing').classList.add('active');
    }
}

function navTo(page) {
    document.querySelectorAll('.pane').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));

    document.getElementById(`pane-${page}`).classList.remove('hidden');
    document.getElementById(`pane-${page}`).classList.add('active');

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    // rudimentary naming match
    // ...
}

function updateUI(user) {
    document.getElementById('display-username').innerText = user.username;
    document.getElementById('credit-count').innerText = user.credits;
}

// --- File Handling ---
// Drag & Drop
const dropZone = document.getElementById('drop-zone');
if (dropZone) {
    dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
    };
    dropZone.onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = e => {
        if (e.target.files.length) processFile(e.target.files[0]);
    };
}

async function processFile(file) {
    if (!currentUser) { showToast("Please login first"); return; }

    wsDrop.classList.add('hidden');
    wsLoad.classList.remove('hidden');
    document.getElementById('loading-title').textContent = "Uploading Master...";
    document.getElementById('upload-progress-container').classList.remove('hidden');

    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/process_file_async`, true);
    xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            document.getElementById('upload-bar').style.width = percent + "%";
            document.getElementById('upload-percent').textContent = percent + "%";
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            // Job Started
            startJobPolling(data.job_id);
            localStorage.setItem('active_stem_job', data.job_id);
            updateDashboard(); // Add to grid
        } else {
            showToast("Upload Failed");
            resetWorkspace();
        }
    };
    xhr.send(formData);
}

// --- Polling ---
let statusInterval = null;
function startJobPolling(jobId) {
    wsDrop.classList.add('hidden');
    wsLoad.classList.remove('hidden');
    document.getElementById('upload-progress-container').classList.add('hidden');

    const logEl = document.getElementById('processing-log');
    const timerEl = document.getElementById('process-timer');
    let startTime = Date.now();

    if (statusInterval) clearInterval(statusInterval);

    statusInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/jobs/${jobId}`);
            if (!res.ok) return;
            const job = await res.json();

            // Update Log
            if (job.status === 'processing') {
                document.getElementById('loading-title').textContent = "Separating Stems...";
                // Update timer
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const s = (elapsed % 60).toString().padStart(2, '0');
                if (timerEl) timerEl.textContent = `${m}:${s}`;
            }

            if (job.status === 'completed') {
                clearInterval(statusInterval);
                localStorage.removeItem('active_stem_job');
                loadMixer(job.filename, job.stems);
                showToast("Separation Complete!");
                fetchUser(); // Credits update
            } else if (job.status === 'failed') {
                clearInterval(statusInterval);
                localStorage.removeItem('active_stem_job');
                showToast("Job Failed");
                resetWorkspace();
            }
        } catch (e) {
            console.error(e);
        }
    }, 2000);
}

function resetWorkspace() {
    wsLoad.classList.add('hidden');
    wsMixer.classList.add('hidden');
    wsDrop.classList.remove('hidden');
}


// --- DASHBOARD (Active Projects) ---
async function updateDashboard() {
    if (!currentUser) return;
    const grid = document.getElementById('active-projects-grid');
    if (!grid) return;

    try {
        const res = await fetch(`${API_BASE}/my_jobs`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const jobs = await res.json();

        grid.innerHTML = '';
        if (jobs.length === 0) {
            grid.innerHTML = '<p style="text-align:center; color:var(--text-sec); grid-column:1/-1;">No recent projects</p>';
            return;
        }

        jobs.forEach(job => {
            const card = document.createElement('div');
            card.className = 'job-card';
            if (job.status === 'processing') card.classList.add('active');

            let statusBadge = `<span class="badge ${job.status}">${job.status}</span>`;
            if (job.status === 'completed') statusBadge = `<span class="badge success">Ready</span>`;

            card.innerHTML = `
                <div class="job-card-header">
                    <h4>${job.filename || 'Untitled Project'}</h4>
                    ${statusBadge}
                </div>
                <div class="job-card-meta">
                    <span>${new Date(job.created_at * 1000).toLocaleDateString()}</span>
                    <span>${job.model || 'htdemucs'}</span>
                </div>
            `;

            // Click to Open
            card.onclick = () => {
                if (job.status === 'completed') loadMixer(job.filename, job.stems);
                if (job.status === 'processing') startJobPolling(job.id);
            };

            grid.appendChild(card);
        });

    } catch (e) { console.error(e); }
}


// --- MIXER LOGIC (WaveSurfer) ---
const STEM_COLORS = {
    vocals: '#ff9ff3', // Pink
    drums: '#feca57',  // Orange
    bass: '#54a0ff',   // Blue
    other: '#1dd1a1'   // Teal
};

let stemsWS = {};
let isPlaying = false;
let masterWS = null; // Driver

async function downloadZip(projectId) {
    window.location.href = `${API_BASE}/download_zip/${projectId}`;
}

function closeMixer() {
    Object.values(stemsWS).forEach(ws => ws.destroy());
    stemsWS = {};
    isPlaying = false;
    wsMixer.classList.add('hidden');
    resetWorkspace(); // Or go back to Dashboard?
    updateDashboard(); // Refresh
}

function loadMixer(title, stems) {
    if (!stems) return;

    // UI
    wsLoad.classList.add('hidden');
    wsDrop.classList.add('hidden');
    wsMixer.classList.remove('hidden');
    wsMixer.style.display = 'block';

    document.getElementById('project-title').textContent = title;

    // Buttons
    const firstStem = Object.values(stems)[0];
    const projectId = firstStem.split('/')[3];

    document.getElementById('btn-zip-download').onclick = () => downloadZip(projectId);
    document.getElementById('btn-close-mixer').onclick = closeMixer;

    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';

    // Transport UI
    const playBtn = document.getElementById('play-btn');
    const seekSlider = document.getElementById('seek-slider');
    const timeDisplay = document.getElementById('time-display');
    const durDisplay = document.getElementById('duration-display');

    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = true; }
    if (timeDisplay) timeDisplay.textContent = "00:00";
    if (durDisplay) durDisplay.textContent = "00:00";

    stemsWS = {};
    isPlaying = false;
    masterWS = null;

    const tpl = document.getElementById('channel-template');
    const sortOrder = ['vocals', 'drums', 'bass', 'other'];
    const sortedKeys = Object.keys(stems).sort((a, b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));

    sortedKeys.forEach((name, index) => {
        const url = stems[name];
        const strip = tpl.content.cloneNode(true);
        const stripDiv = strip.querySelector('.channel-strip');

        let dName = name.toUpperCase();
        let color = STEM_COLORS.other;
        if (name === 'vocals') color = STEM_COLORS.vocals;
        if (name === 'drums' || name === 'percussion') { dName = 'DRUMS'; color = STEM_COLORS.drums; }
        if (name === 'bass') color = STEM_COLORS.bass;
        if (name === 'other') { dName = 'INSTRUMENTS'; color = STEM_COLORS.other; }

        strip.querySelector('.ch-name').textContent = dName;
        strip.querySelector('.ch-name').style.color = color;
        stripDiv.style.borderLeft = `3px solid ${color}`;

        const iconDiv = strip.querySelector('.ch-icon');
        iconDiv.style.color = color;
        // Icons... (Use standard FontAwesome)
        if (name === 'vocals') iconDiv.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        else if (name === 'bass') iconDiv.innerHTML = '<i class="fa-solid fa-wave-square"></i>';
        else if (name === 'drums' || name === 'percussion') iconDiv.innerHTML = '<i class="fa-solid fa-drum"></i>';
        else iconDiv.innerHTML = '<i class="fa-solid fa-music"></i>';

        // WaveSurfer Container
        const cvs = strip.querySelector('canvas');
        const wsId = `ws-${name}-${Math.random().toString(36).substr(2, 9)}`;
        const wsContainer = document.createElement('div');
        wsContainer.id = wsId;
        wsContainer.className = 'ws-waveform-container';
        if (cvs) cvs.replaceWith(wsContainer);

        // Download Button
        const dlBtn = document.createElement('a');
        dlBtn.href = url;
        dlBtn.download = '';
        dlBtn.className = 'ch-download-btn';
        dlBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
        dlBtn.title = "Download Stem";

        // Grid Layout: Icon/Name | WS | Download | Controls
        // Current HTML in template has: Icon, Name+Link, Canvas, Fader, Controls
        // We need to inject DL button at correct spot.
        // Let's just append it to the strip and rely on Grid order.
        stripDiv.insertBefore(dlBtn, stripDiv.querySelector('.ch-controls'));
        const fader = stripDiv.querySelector('.ch-fader-wrap');
        if (fader) fader.style.display = 'none'; // Hide fader

        container.appendChild(stripDiv);

        // Init WS
        const ws = WaveSurfer.create({
            container: `#${wsId}`,
            waveColor: color,
            progressColor: '#ffffff',
            cursorColor: '#ffffff',
            barWidth: 3,
            barGap: 3,
            barRadius: 3,
            height: 50,
            normalize: true,
            backend: 'MediaElement', // Instant Play
            hideScrollbar: true
        });

        ws.load(url);
        stemsWS[name] = { ws, muted: false };

        if (index === 0) {
            masterWS = ws;
            ws.on('ready', () => {
                const dur = ws.getDuration();
                const m = Math.floor(dur / 60);
                const s = Math.floor(dur % 60).toString().padStart(2, '0');
                if (durDisplay) durDisplay.textContent = `${m}:${s}`;
                if (seekSlider) { seekSlider.max = dur; seekSlider.disabled = false; }
            });
            ws.on('timeupdate', (t) => {
                if (seekSlider) seekSlider.value = t;
                const m = Math.floor(t / 60);
                const s = Math.floor(t % 60).toString().padStart(2, '0');
                if (timeDisplay) timeDisplay.textContent = `${m}:${s}`;
            });
            ws.on('finish', () => {
                isPlaying = false;
                playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            });
        }

        // Interaction Sync
        ws.on('interaction', (t) => {
            Object.values(stemsWS).forEach(s => {
                if (s.ws !== ws) s.ws.setTime(t);
            });
        });

        // Mute/Solo UI
        const mBtn = stripDiv.querySelector('.mute');
        mBtn.onclick = () => {
            stemsWS[name].muted = !stemsWS[name].muted;
            mBtn.classList.toggle('active', stemsWS[name].muted);
            ws.setVolume(stemsWS[name].muted ? 0 : 1);
        };
        const sBtn = stripDiv.querySelector('.solo');
        sBtn.innerHTML = '<i class="fa-solid fa-headphones"></i>';
        sBtn.onclick = () => {
            const isSolo = sBtn.classList.contains('active');
            document.querySelectorAll('.solo').forEach(b => b.classList.remove('active'));
            if (isSolo) {
                Object.values(stemsWS).forEach(t => t.ws.setVolume(t.muted ? 0 : 1));
            } else {
                sBtn.classList.add('active');
                Object.entries(stemsWS).forEach(([k, t]) => {
                    t.ws.setVolume(k === name ? 1 : 0);
                });
            }
        }
    });

    // Play Button
    if (playBtn) {
        playBtn.onclick = () => {
            if (isPlaying) {
                Object.values(stemsWS).forEach(s => s.ws.pause());
                isPlaying = false;
                playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            } else {
                Object.values(stemsWS).forEach(s => s.ws.play());
                isPlaying = true;
                playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            }
        }
    }

    // Slider
    if (seekSlider) {
        seekSlider.oninput = (e) => {
            const t = e.target.value;
            Object.values(stemsWS).forEach(s => s.ws.setTime(t));
        }
    }
}


// --- Hero Visuals (Simple Orb) ---
function initHeroVisuals() {
    // CSS Based - no JS needed
}

function initScrollObs() { }
function initDemoPlayer() { }
