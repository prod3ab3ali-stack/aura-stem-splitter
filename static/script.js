
// --- Global State ---
const API_BASE = '/api';
let authToken = localStorage.getItem('aura_token');
let currentUser = null;

// Audio Context (for FX only if needed, but WS handles its own)
let audioContext = null;
let masterGain = null;

// --- Theme ---
const currentTheme = localStorage.getItem('aura_theme') || 'dark';

function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('aura_theme', mode);
    updateThemeUI(mode);
}

function updateThemeUI(mode) {
    document.querySelectorAll('.theme-opt').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(mode)) btn.classList.add('active');
    });
}

// --- Toast ---
function showToast(msg) {
    let c = document.getElementById('toast-container');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toast-container';
        document.body.appendChild(c);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    setTheme(currentTheme);

    // Auth Check
    if (!authToken) {
        document.getElementById('auth-shade').style.display = 'flex';
        document.getElementById('auth-sidebar').classList.add('open');
    } else {
        await fetchUser();
    }

    // Loading Curtain
    setTimeout(() => {
        const l = document.getElementById('loader-curtain');
        if (l) { l.style.opacity = '0'; setTimeout(() => l.remove(), 500); }
    }, 500);

    // Initial Dashboard Load
    updateDashboard();

    // Setup Navigation
    setupNav();
    setupDropZone();
});

// --- Auth & User ---
async function fetchUser() {
    try {
        const res = await fetch(`${API_BASE}/users/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            currentUser = await res.json();
            updateUI(currentUser);
        } else {
            authToken = null;
            localStorage.removeItem('aura_token');
            showAuth();
        }
    } catch (e) { console.error(e); }
}

function updateUI(user) {
    const nameEl = document.getElementById('display-username');
    const crEl = document.getElementById('credit-count');
    if (nameEl) nameEl.textContent = user.username;
    if (crEl) crEl.textContent = user.credits;
}

function showAuth() {
    document.getElementById('auth-shade').style.display = 'flex';
    document.getElementById('auth-sidebar').classList.add('open');
}

function closeAuth() {
    document.getElementById('auth-shade').style.display = 'none';
    document.getElementById('auth-sidebar').classList.remove('open');
}

async function handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('auth-user').value;
    const isSignup = document.getElementById('auth-submit').textContent.includes('Start'); // Check valid button text

    // Default password for demo simplicity if hidden
    const p = 'password';

    try {
        // 1. Try Login
        let res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });

        // 2. If 401/400 and we want to "Auto Signup" (Demo Mode)
        if (!res.ok) {
            console.log("Login failed, trying signup...");
            res = await fetch(`${API_BASE}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
            });

            // If signup worked, log in again
            if (res.ok) {
                res = await fetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
            }
        }

        if (res.ok) {
            const data = await res.json();
            authToken = data.token; // API returns { token: "..." }
            localStorage.setItem('aura_token', authToken);
            closeAuth();
            fetchUser();
        } else {
            throw new Error("Auth functionality unavailable");
        }
    } catch (e) {
        console.warn("Backend Auth Failed (Offline Mode?):", e);
        // Fallback Mock
        authToken = "mock_token_" + u;
        localStorage.setItem('aura_token', authToken);
        currentUser = { username: u, credits: 10 };
        updateUI(currentUser);
        closeAuth();
    }
}

document.getElementById('auth-form')?.addEventListener('submit', handleLogin);
window.logout = () => {
    localStorage.removeItem('aura_token');
    location.reload();
};

// --- Navigation ---
function setupNav() {
    window.navTo = (page) => {
        document.querySelectorAll('.pane').forEach(p => p.classList.add('hidden'));
        document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        const target = document.getElementById(`pane-${page}`);
        if (target) {
            target.classList.remove('hidden');
            target.classList.add('active');
        }

        // Find button (heuristic)
        const btn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.textContent.toLowerCase().includes(page));
        if (btn) btn.classList.add('active');

        if (page === 'library') loadLibrary();
    };
}

// --- Dashboard & Jobs ---
async function updateDashboard() {
    // Determine where to render active jobs.
    // We'll put them in the 'input-tabs' area or a dedicated list?
    // User wants "Active projects" designed well.
    // Let's create a container "active-jobs-list" in workspace if not exists

    if (!currentUser) return;

    try {
        const res = await fetch(`${API_BASE}/my_jobs`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const jobs = await res.json();
            renderJobs(jobs);
        }
    } catch (e) { }
}

function renderJobs(jobs) {
    // We'll use the Library pane for history, but maybe show Active jobs in Workspace?
    // Let's update the 'library-list'
    const box = document.getElementById('library-list');
    if (!box) return;

    box.innerHTML = '';
    if (jobs.length === 0) {
        box.innerHTML = '<div class="empty-state">No projects yet. Start creating!</div>';
        return;
    }

    jobs.forEach(job => {
        const el = document.createElement('div');
        el.className = 'job-card';
        // Design CSS for this will be fixed in CSS step

        let statusBadge = `<span class="badge ${job.status}">${job.status}</span>`;
        if (job.status === 'processing') statusBadge = `<span class="badge processing"><i class="fa-solid fa-circle-notch fa-spin"></i> Processing</span>`;
        if (job.status === 'failed') statusBadge = `<span class="badge failed">Failed</span>`;

        el.innerHTML = `
            <div class="job-info">
                <div class="job-title">${job.filename || 'Untitled Project'}</div>
                <div class="job-meta">${new Date(job.created_at * 1000).toLocaleString()}</div>
            </div>
            <div class="job-status">${statusBadge}</div>
            <div class="job-actions">
                ${job.status === 'completed' ? `<button class="btn-action open-mix" onclick="openJob('${job.id}')">Open Studio</button>` : ''}
            </div>
        `;
        box.appendChild(el);
    });
}

window.openJob = async (jobId) => {
    // Fetch Job Details
    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'completed' && data.stems) {
                // Switch to workspace
                navTo('workspace');
                loadMixer(data.filename, data.stems);
            } else {
                showToast("Job not ready yet");
            }
        }
    } catch (e) { showToast("Error loading job"); }
};


// --- MIXER LOGIC (WaveSurfer MediaElement) ---
const STEM_COLORS = {
    vocals: '#D291BC', // Pink
    drums: '#F59E0B',  // Amber/Gold
    bass: '#3B82F6',   // Blue
    other: '#10B981'   // Emerald/Teal
};

let stemsWS = {};
let isPlaying = false;
let masterWS = null;

function loadMixer(title, stems) {
    if (!stems) return;

    // UI Setup
    const wsMixer = document.getElementById('ws-mixer');
    const wsDrop = document.getElementById('ws-drop');
    const wsLoad = document.getElementById('ws-loading'); // ensure this exists in HTML
    if (wsDrop) wsDrop.classList.add('hidden');
    // We don't need wsLoad for instant play, maybe just show mixer directly

    wsMixer.classList.remove('hidden');
    wsMixer.style.display = 'block';

    const titleEl = document.getElementById('project-title');
    if (titleEl) titleEl.textContent = title;

    // Reset Elements
    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';
    const playBtn = document.getElementById('play-btn');
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    isPlaying = false;

    const seekSlider = document.getElementById('seek-slider');
    const timeDisplay = document.getElementById('time-display');
    const durDisplay = document.getElementById('duration-display');

    if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = false; }
    if (timeDisplay) timeDisplay.textContent = "00:00";
    if (durDisplay) durDisplay.textContent = "00:00";

    stemsWS = {};
    const tpl = document.getElementById('channel-template');

    // Sort
    const sortOrder = ['vocals', 'drums', 'bass', 'other'];
    const sortedKeys = Object.keys(stems).sort((a, b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));

    sortedKeys.forEach((name, index) => {
        const url = stems[name];

        // --- Create Strip ---
        const strip = tpl.content.cloneNode(true);
        const stripDiv = strip.querySelector('.channel-strip');

        let displayName = name.toUpperCase();
        let color = STEM_COLORS.other;

        if (name === 'vocals') color = STEM_COLORS.vocals;
        if (name === 'drums' || name === 'percussion') { displayName = 'DRUMS'; color = STEM_COLORS.drums; }
        if (name === 'bass') color = STEM_COLORS.bass;
        if (name === 'other') { displayName = 'INSTRUMENTS'; color = STEM_COLORS.other; }

        strip.querySelector('.ch-name').textContent = displayName;
        strip.querySelector('.ch-name').style.color = color;
        stripDiv.style.borderLeft = `4px solid ${color}`;

        // Icon
        const iconDiv = strip.querySelector('.ch-icon');
        iconDiv.style.color = color;
        const iconMap = { vocals: 'microphone-lines', drums: 'drum', bass: 'wave-square', other: 'guitar' };
        // fallback
        let ico = iconMap[name] || iconMap[name === 'percussion' ? 'drums' : 'other'];
        iconDiv.innerHTML = `<i class="fa-solid fa-${ico}"></i>`;

        // Download Button (Fix placement)
        // Check if existing download link exists or create new
        let dlBtn = strip.querySelector('.btn-download');
        if (!dlBtn) {
            // If template doesn't have it, we create or re-use the 'a' tag
            const aTag = strip.querySelector('a'); // existing hidden link?
            // Let's make a proper button
            const controls = strip.querySelector('.ch-controls');
            // Insert Download button at start of controls or end?
            // "Download buttons is not placed well". 
            // Let's place it explicitly.
            const newDl = document.createElement('a');
            newDl.href = url;
            newDl.download = `${title}-${name}.wav`;
            newDl.className = 'btn-mini';
            newDl.innerHTML = '<i class="fa-solid fa-download"></i>';
            newDl.title = "Download Stem";
            controls.appendChild(newDl); // Add to controls group
        }

        // WaveSurfer Container
        const canvas = strip.querySelector('canvas');
        const wsId = `ws-${name}-${Date.now()}`;
        const wsContainer = document.createElement('div');
        wsContainer.id = wsId;
        wsContainer.className = 'ws-pattern';
        wsContainer.style.width = '100%';
        wsContainer.style.height = '60px'; // Fixed height
        if (canvas) canvas.replaceWith(wsContainer);

        container.appendChild(stripDiv);

        // --- WaveSurfer Init (Instant Play) ---
        const ws = WaveSurfer.create({
            container: `#${wsId}`,
            waveColor: color, // Full Color
            progressColor: 'rgba(255,255,255,0.4)', // White overlay for progress
            cursorColor: '#fff',
            cursorWidth: 2,
            barWidth: 3,
            barGap: 2,
            barRadius: 3,
            height: 60,
            backend: 'MediaElement', // Key for Instant Play
            normalize: true,
            hideScrollbar: true,
        });

        ws.load(url);
        stemsWS[name] = { ws, muted: false };

        // --- Event Handlers ---
        if (index === 0) {
            // Master Driver
            masterWS = ws;

            // Duration
            ws.on('ready', () => {
                const d = ws.getDuration();
                if (d && isFinite(d)) {
                    if (seekSlider) { seekSlider.max = d; seekSlider.disabled = false; }
                    const m = Math.floor(d / 60);
                    const s = Math.floor(d % 60).toString().padStart(2, '0');
                    if (durDisplay) durDisplay.textContent = `${m}:${s}`;
                }
            });

            // Time Update
            ws.on('audioprocess', (t) => {
                if (seekSlider) seekSlider.value = t;
                const m = Math.floor(t / 60);
                const s = Math.floor(t % 60).toString().padStart(2, '0');
                if (timeDisplay) timeDisplay.textContent = `${m}:${s}`;
            });

            // Finish
            ws.on('finish', () => {
                isPlaying = false;
                if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            });
        }

        // Sync Interaction (Clicking waveform)
        ws.on('interaction', (newTime) => {
            // Seek all others
            Object.values(stemsWS).forEach(s => {
                if (s.ws !== ws) s.ws.setTime(newTime);
            });
        });

        // Controls (Mute/Solo)
        const mBtn = stripDiv.querySelector('.mute');
        mBtn.onclick = () => {
            stemsWS[name].muted = !stemsWS[name].muted;
            mBtn.classList.toggle('active', stemsWS[name].muted);
            ws.setMuted(stemsWS[name].muted);
        };

        const sBtn = stripDiv.querySelector('.solo');
        sBtn.innerHTML = '<i class="fa-solid fa-headphones"></i>';
        sBtn.onclick = () => {
            const isSolo = sBtn.classList.contains('active');
            document.querySelectorAll('.solo').forEach(b => b.classList.remove('active'));

            if (isSolo) {
                // Unsolo -> Unmute all (respecting previous mute state? simplifying to unmute all for now)
                Object.values(stemsWS).forEach(t => t.ws.setMuted(t.muted));
            } else {
                // Solo -> Mute others
                sBtn.classList.add('active');
                Object.entries(stemsWS).forEach(([k, t]) => {
                    if (k === name) t.ws.setMuted(false);
                    else t.ws.setMuted(true);
                });
            }
        };
    });

    // --- Global Transport Bindings ---
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

    if (seekSlider) {
        seekSlider.oninput = (e) => {
            const t = parseFloat(e.target.value);
            Object.values(stemsWS).forEach(s => s.ws.setTime(t));
        };
    }
}

function handleCloseMixer() {
    // stop
    if (Object.keys(stemsWS).length) {
        Object.values(stemsWS).forEach(s => s.ws.destroy());
    }
    stemsWS = {};
    isPlaying = false;
    document.getElementById('ws-mixer').classList.add('hidden');
    // document.getElementById('ws-drop').classList.remove('hidden'); // Optional: go back to drop?
    navTo('library');
}
document.getElementById('btn-close-mixer').onclick = handleCloseMixer;


// --- Drag & Drop Processing ---
function setupDropZone() {
    const dropZone = document.getElementById('drop-zone');
    const input = document.getElementById('file-upload');

    if (!dropZone || !input) return;

    dropZone.onclick = () => input.click();
    input.onchange = (e) => {
        if (e.target.files.length) processFile(e.target.files[0]);
    };

    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragging'); };
    dropZone.ondragleave = (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragging');
        if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
    };
}

async function processFile(file) {
    if (!currentUser) { showToast("Login Required"); return; }

    // UI Update
    // Hide Drop, Show Loading
    // Assuming HTML has these IDs
    const wsDrop = document.getElementById('ws-drop');
    const wsLoad = document.getElementById('ws-loading'); // Make sure to add this in HTML if missing
    if (wsDrop) wsDrop.classList.add('hidden');
    // Simple toast for now
    showToast("Uploading: " + file.name);

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/process_file_async`, true);
    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

    xhr.onload = () => {
        if (xhr.status === 200) {
            const res = JSON.parse(xhr.responseText);
            showToast("Upload Complete. Processing...");
            navTo('library'); // Go to library to see progress
            updateDashboard(); // Refresh list
        } else {
            showToast("Upload Failed");
            if (wsDrop) wsDrop.classList.remove('hidden');
        }
    };
    xhr.send(formData);
}

