// --- Global State ---
let authToken = localStorage.getItem('aura_token');
let currentUser = null;
const API_BASE = '/api';

// --- Constants ---
const STEM_COLORS = {
    vocals: '#D291BC', // Pink
    drums: '#e67e22',  // Orange
    bass: '#3498db',   // Blue
    other: '#1abc9c'   // Teal
};

// --- Theme ---
function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('aura_theme', mode);
    document.querySelectorAll('.theme-opt').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(mode));
    });
}
const currentTheme = localStorage.getItem('aura_theme') || 'dark';

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    setTheme(currentTheme);
    initScrollObs();
    initDemoPlayer();

    // Curtain
    setTimeout(() => {
        const loader = document.getElementById('loader-curtain');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.remove(), 500);
        }
    }, 800);

    // Auth & Session
    await fetchUser();

    // Recovery
    const activeJobId = localStorage.getItem('active_stem_job');
    if (activeJobId) {
        console.log("Recovering job:", activeJobId);
        startJobPolling(activeJobId);
    }

    // Init Visuals
    const heroCanvas = document.getElementById('hero-canvas');
    if (heroCanvas) initHeroVisuals(); // Legacy checks
});

// --- Auth Logic ---
async function fetchUser() {
    if (!authToken) return showAuth();
    try {
        const res = await fetch(`${API_BASE}/me`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) {
            currentUser = await res.json();
            updateUI(currentUser);
        } else {
            logout();
        }
    } catch (e) { logout(); }
}

function updateUI(user) {
    document.getElementById('auth-sidebar').classList.remove('open');
    document.getElementById('auth-shade').classList.remove('open');
    document.querySelector('.auth-trigger').style.display = 'none';
    document.querySelector('.user-brief').style.display = 'flex';
    document.getElementById('display-username').textContent = user.username;
    document.getElementById('credit-count').textContent = user.credits_left;

    // Unlock Views
    document.querySelectorAll('.app-sidebar .nav-btn').forEach(b => b.classList.remove('disabled'));
}

function showAuth() {
    document.getElementById('auth-sidebar').classList.add('open');
    document.getElementById('auth-shade').classList.add('open');
}

function closeAuth() {
    document.getElementById('auth-sidebar').classList.remove('open');
    document.getElementById('auth-shade').classList.remove('open');
}

function logout() {
    localStorage.removeItem('aura_token');
    location.reload();
}

// --- Navigation ---
function navTo(page) {
    if (!currentUser) return showAuth();

    document.querySelectorAll('.pane').forEach(p => {
        p.classList.add('hidden');
        p.classList.remove('active');
    });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const target = document.getElementById(`pane-${page}`);
    if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
    }

    // Update Button State
    const btnMap = { 'workspace': 0, 'library': 1, 'store': 2, 'admin': 3 };
    const btns = document.querySelectorAll('.app-sidebar .nav-btn');
    if (btns[btnMap[page]]) btns[btnMap[page]].classList.add('active');

    // Logic
    if (page === 'library') loadLibrary();
    if (page === 'workspace') updateDashboard();
}

function switchView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewName}`).classList.add('active');
    if (viewName === 'app') {
        navTo('workspace');
        updateDashboard();
    }
}

// --- Dashboard & Jobs ---
async function updateDashboard() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/my_jobs`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const jobs = await res.json();
            renderDashboard(jobs);
        }
    } catch (e) { console.error(e); }
}

function renderDashboard(jobs) {
    const activeContainer = document.getElementById('active-jobs-list');
    const historyContainer = document.getElementById('history-list');

    if (!activeContainer || !historyContainer) return;

    activeContainer.innerHTML = '';
    historyContainer.innerHTML = '';

    const reversed = jobs.slice().reverse();

    reversed.forEach(job => {
        const isProcessing = ['queued', 'processing', 'downloading'].includes(job.status);
        const el = document.createElement('div');
        el.className = 'job-card';
        // Status Badge Color
        let badgeClass = 'neutral';
        if (job.status === 'completed') badgeClass = 'success';
        if (job.status === 'failed') badgeClass = 'error';
        if (isProcessing) badgeClass = 'warning';

        el.innerHTML = `
            <div class="jc-icon">
                <i class="fa-solid fa-music"></i>
            </div>
            <div class="jc-info">
                <h4>${job.filename || 'Untitled Project'}</h4>
                <div class="jc-meta">
                    <span class="status-badge ${badgeClass}">${job.status}</span>
                    <span class="date">${new Date(job.created_at * 1000).toLocaleDateString()}</span>
                </div>
            </div>
            ${isProcessing ? '<div class="loader-spinner small"></div>' : '<i class="fa-solid fa-chevron-right"></i>'}
        `;

        el.onclick = () => handleJobClick(job);

        if (isProcessing) activeContainer.appendChild(el);
        else historyContainer.appendChild(el);
    });

    if (activeContainer.children.length === 0) {
        activeContainer.innerHTML = '<div class="empty-state">No active projects</div>';
    }
}

function handleJobClick(job) {
    if (job.status === 'completed' && job.outputs) {
        loadMixer(job.filename, job.outputs);
    } else if (job.status === 'failed') {
        showToast(`Job Failed: ${job.error || 'Unknown Error'}`);
    } else {
        showToast("Project is still processing...");
    }
}

// --- File Processing ---
async function processFile(file) {
    if (!currentUser) return showToast("Login required");

    const wsDrop = document.getElementById('ws-drop');
    const wsLoad = document.getElementById('ws-loading');

    wsDrop.classList.add('hidden');
    wsLoad.classList.remove('hidden');

    document.getElementById('loading-title').textContent = "Uploading Master...";
    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/process_file_async`, true);
    xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const p = Math.round((e.loaded / e.total) * 100);
            document.getElementById('upload-bar').style.width = p + "%";
            document.getElementById('upload-percent').textContent = p + "%";
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            localStorage.setItem('active_stem_job', data.job_id);
            startJobPolling(data.job_id);
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
    document.getElementById('loading-title').textContent = "Neural Processing...";
    document.getElementById('ws-drop').classList.add('hidden');
    document.getElementById('ws-loading').classList.remove('hidden');

    if (statusInterval) clearInterval(statusInterval);

    statusInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/jobs/${jobId}`);
            if (res.ok) {
                const job = await res.json();
                updateStatusLog(job.status);

                if (job.status === 'completed') {
                    clearInterval(statusInterval);
                    localStorage.removeItem('active_stem_job');
                    loadMixer(job.filename, job.outputs);
                    updateDashboard(); // Refesh list
                }
                if (job.status === 'failed') {
                    clearInterval(statusInterval);
                    localStorage.removeItem('active_stem_job');
                    showToast("Processing Failed");
                    resetWorkspace();
                }
            }
        } catch (e) { console.error(e); }
    }, 2000);
}

function updateStatusLog(status) {
    const log = document.getElementById('processing-log');
    if (log) log.innerHTML = `<div>Status: ${status}...</div>`;
}

function resetWorkspace() {
    document.getElementById('ws-loading').classList.add('hidden');
    document.getElementById('ws-mixer').classList.add('hidden');
    document.getElementById('ws-drop').classList.remove('hidden');
}

// --- Mixer Logic (Optimized WaveSurfer) ---
let stemsWS = {};
let isPlaying = false;
let seekerInterval = null;

// Helper to adjust hex color opacity/brightness
function adjustColor(color, amount) {
    // Simple placeholder, we strictly use hex + opacity string for now
    return color;
}

function loadMixer(title, stems) {
    if (!stems) return;

    // Setup UI
    document.getElementById('ws-loading').classList.add('hidden');
    document.getElementById('ws-drop').classList.add('hidden');
    const mixerKey = document.getElementById('ws-mixer');
    mixerKey.classList.remove('hidden');
    mixerKey.style.display = 'block';

    document.getElementById('project-title').textContent = title;

    // Reset Transport
    const playBtn = document.getElementById('play-btn');
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    isPlaying = false;

    // Sort
    const sortOrder = ['vocals', 'drums', 'bass', 'other'];
    const sortedKeys = Object.keys(stems).sort((a, b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));

    // Clear Container
    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';

    stemsWS = {};
    const tpl = document.getElementById('channel-template');
    let masterWS = null; // Driver

    // Global Slider
    const seekSlider = document.getElementById('seek-slider');
    const timeDisp = document.getElementById('time-display');
    const durDisp = document.getElementById('duration-display');
    if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = true; }

    sortedKeys.forEach((name, index) => {
        const url = stems[name];
        const strip = tpl.content.cloneNode(true);
        const stripDiv = strip.querySelector('.channel-strip');

        let displayName = name.toUpperCase();
        let baseColor = STEM_COLORS.other;
        if (name === 'vocals') baseColor = STEM_COLORS.vocals;
        if (name === 'drums' || name === 'percussion') { displayName = 'DRUMS'; baseColor = STEM_COLORS.drums; }
        if (name === 'bass') baseColor = STEM_COLORS.bass;

        // Populate Strip
        strip.querySelector('.ch-name').textContent = displayName;
        strip.querySelector('.ch-name').style.color = baseColor;
        stripDiv.style.borderLeft = `4px solid ${baseColor}`;

        // DL Link
        const dlBtn = strip.querySelector('.dl');
        if (dlBtn) dlBtn.href = url;

        // WS Container
        const wsId = `ws-${name}-${Date.now()}`; // Unique ID
        const visContainer = document.createElement('div');
        visContainer.id = wsId;
        visContainer.className = 'ws-waveform-container';

        const oldVis = strip.querySelector('.ch-vis');
        if (oldVis) oldVis.replaceWith(visContainer);

        container.appendChild(stripDiv);

        // Init WaveSurfer
        const ws = WaveSurfer.create({
            container: `#${wsId}`,
            waveColor: baseColor + '55', // Dimmed (Hex Opacity)
            progressColor: baseColor,    // Bright
            cursorColor: '#ffffff',
            cursorWidth: 2,
            barWidth: 3,
            barGap: 2,
            barRadius: 2,
            height: 60,
            normalize: true,
            backend: 'WebAudio',
            pixelRatio: 1, // High Perf
            minPxPerSec: 50
        });

        ws.load(url);
        ws.setVolume(1);
        stemsWS[name] = { ws, muted: false };

        // Events
        ws.on('ready', () => {
            if (index === 0) {
                const dur = ws.getDuration();
                if (durDisp) durDisp.textContent = fmtTime(dur);
                if (seekSlider) { seekSlider.max = dur; seekSlider.disabled = false; }
            }
        });

        ws.on('interaction', (t) => {
            Object.values(stemsWS).forEach(s => {
                if (s.ws !== ws) s.ws.setTime(t);
            });
            if (seekSlider) seekSlider.value = t;
        });

        ws.on('finish', () => {
            if (index === 0) {
                isPlaying = false;
                playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }
        });

        // Controls
        const muteBtn = stripDiv.querySelector('.mute');
        muteBtn.onclick = () => {
            stemsWS[name].muted = !stemsWS[name].muted;
            muteBtn.classList.toggle('active', stemsWS[name].muted);
            ws.setVolume(stemsWS[name].muted ? 0 : 1);
        };

        const soloBtn = stripDiv.querySelector('.solo');
        soloBtn.onclick = () => {
            // Solo logic
            const isSolo = soloBtn.classList.contains('active');
            document.querySelectorAll('.solo').forEach(b => b.classList.remove('active'));
            if (isSolo) {
                // Unsolo all
                Object.values(stemsWS).forEach(t => t.ws.setVolume(t.muted ? 0 : 1));
            } else {
                soloBtn.classList.add('active');
                Object.entries(stemsWS).forEach(([k, t]) => {
                    t.ws.setVolume(k === name ? 1 : 0);
                });
            }
        };

        if (index === 0) masterWS = ws;
    });

    // Transport Buttons
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
        };
    }

    // Seek Slider Binding
    if (seekSlider) {
        seekSlider.oninput = (e) => {
            const t = parseFloat(e.target.value);
            Object.values(stemsWS).forEach(s => s.ws.setTime(t));
        };
        if (masterWS) {
            masterWS.on('audioprocess', (t) => {
                seekSlider.value = t;
                if (timeDisp) timeDisp.textContent = fmtTime(t);
            });
        }
    }
}

function fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}

// --- Utils ---
function showToast(msg) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function initScrollObs() {
    // Stub
}
function initDemoPlayer() {
    // Stub
}
function initHeroVisuals() {
    // Stub
}

// --- Auth Forms ---
// (Simplified for brevity, assuming existing HTML handles auth submission via ID hooks, 
// need to re-add event listeners if they were in script.js)
const authForm = document.getElementById('auth-form');
if (authForm) {
    authForm.onsubmit = async (e) => {
        e.preventDefault();
        const user = document.getElementById('auth-user').value;
        try {
            const res = await fetch(`${API_BASE}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `username=${encodeURIComponent(user)}`
            });
            if (res.ok) {
                const data = await res.json();
                localStorage.setItem('aura_token', data.access_token);
                authToken = data.access_token;
                fetchUser();
                closeAuth();
            }
        } catch (e) { showToast("Login Error"); }
    };
}
