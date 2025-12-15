
// --- Global State ---
let authToken = localStorage.getItem('aura_token');
let currentUser = null;

// --- Global Theme Function ---
function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    document.querySelectorAll('.theme-opt').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(mode)) btn.classList.add('active');
    });
    localStorage.setItem('aura_theme', mode);
}

let audioContext = null;
let masterGain = null;
let demoAudio = {}; // For Landing Demo
let masterState = 'stopped'; // playing, paused, stopped

// Config
const API_BASE = '/api';
let currentTheme = localStorage.getItem('aura_theme') || 'dark'; // FORCE DARK DEFAULT
if (!localStorage.getItem('aura_theme')) setTheme('dark');

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
    initHeroVisuals(); // Keep the orb/glow
    initScrollObs();
    initDemoPlayer();

    // Simulate initial loading
    setTimeout(() => {
        const loader = document.getElementById('loader-curtain');
        if (loader) loader.style.opacity = '0';
        setTimeout(() => loader?.remove(), 500);
    }, 800);

    // 1. Recover Session
    await fetchUser();

    // 2. Check for Active Job (Persistence)
    const activeJobId = localStorage.getItem('active_stem_job');
    if (activeJobId) {
        // We don't block, we just start polling
        startJobPolling(activeJobId);
    }

    // 3. Init Dashboard if logged in
    if (authToken) {
        switchView('app'); // Go straight to app if logged in? Or Landing?
        // Let's stay on landing if no active job, to show off design
        // updateDashboard(); // But update data in background
    }
});

function applyTheme(mode) {
    setTheme(mode);
}

function initScrollObs() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) entry.target.classList.add('visible');
        });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal-text, .fade-in, .scale-up').forEach(el => observer.observe(el));
}


// --- Hero Visuals ---
function initHeroVisuals() {
    // We removed the canvas logic in favor of CSS orb, 
    // but we can add mouse parallax here if needed.
    // Keeping it empty for performance as requested "Instant".
}

// --- Demo Player ---
function initDemoPlayer() {
    // Simple toggle logic for the landing page demo
    const mixer = document.getElementById('demo-mixer');
    if (!mixer) return;
    // ... demo logic ...
}

// --- Auth ---
function openAuth() {
    // Check if sidebar exists
    const sidebar = document.getElementById('auth-sidebar');
    const shade = document.getElementById('auth-shade');
    if (sidebar && shade) {
        sidebar.classList.add('open');
        shade.classList.add('open');
    }
}
function closeAuth() {
    const sidebar = document.getElementById('auth-sidebar');
    const shade = document.getElementById('auth-shade');
    if (sidebar && shade) {
        sidebar.classList.remove('open');
        shade.classList.remove('open');
    }
}
function toggleAuthMode() {
    const form = document.getElementById('auth-form');
    const title = document.getElementById('auth-title');
    const emailGroup = document.getElementById('auth-email-group');
    const modeLabel = document.getElementById('auth-mode-label');
    const btnText = document.getElementById('auth-submit-btn');

    // Toggle Logic (Login <-> Signup)
    if (title.textContent === 'Welcome Back') {
        title.textContent = 'Create Account';
        emailGroup.style.display = 'block';
        modeLabel.innerHTML = 'Already have an account? <span onclick="toggleAuthMode()">Login</span>';
        btnText.textContent = 'Sign Up';
    } else {
        title.textContent = 'Welcome Back';
        emailGroup.style.display = 'none';
        modeLabel.innerHTML = 'New here? <span onclick="toggleAuthMode()">Create Account</span>';
        btnText.textContent = 'Login';
    }
}

// --- USER API ---
async function fetchUser() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/users/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            currentUser = await res.json();
            updateUI(currentUser);
        } else {
            console.warn("Session expired");
            logout();
        }
    } catch (e) { console.error(e); }
}

function updateUI(user) {
    const userDisplay = document.getElementById('display-username');
    const creditDisplay = document.getElementById('credit-count');
    const authBtn = document.getElementById('nav-login');

    if (user) {
        if (userDisplay) userDisplay.textContent = user.username;
        if (creditDisplay) creditDisplay.textContent = user.credits;
        if (authBtn) authBtn.style.display = 'none';
        // Show App Link
        document.getElementById('view-app').classList.remove('hidden');
    }
}

function logout() {
    localStorage.removeItem('aura_token');
    authToken = null;
    currentUser = null;
    window.location.reload();
}


// --- NAVIGATION ---
function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');

    if (viewId === 'app') {
        updateDashboard();
    }
}

function navTo(paneId) {
    if (!currentUser && paneId !== 'store') { showToast("Please Login"); return; }

    // Hide all panes
    document.querySelectorAll('.pane').forEach(p => {
        p.classList.add('hidden');
        p.classList.remove('active');
    });

    // Show target
    const target = document.getElementById(`pane-${paneId}`);
    if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
    }

    // Update Sidebar
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    // Simple mapping logic or add IDs to buttons
}


// --- PROCESSING LOGIC ---
// ... (Keeping it minimal, focusing on Mixer)

async function processFile(file) {
    if (!currentUser) { showToast("Please login first"); return; }

    const wsDrop = document.getElementById('ws-drop');
    const wsLoad = document.getElementById('ws-loading');

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
            // Async started
            showToast("Upload Complete. Processing...");
            startJobPolling(data.job_id);
            localStorage.setItem('active_stem_job', data.job_id);

            // Switch to Dashboard logic (polling view)
            // Ideally active jobs appear in the grid
        } else {
            showToast("Upload Failed");
            resetWorkspace();
        }
    };

    xhr.onerror = () => {
        showToast("Network Error");
        resetWorkspace();
    };

    xhr.send(formData);
}

function resetWorkspace() {
    document.getElementById('ws-drop').classList.remove('hidden');
    document.getElementById('ws-loading').classList.add('hidden');
    document.getElementById('ws-mixer').classList.add('hidden');
}

// --- POLLING ---
let statusInterval;
function startJobPolling(jobId) {
    document.getElementById('ws-drop').classList.add('hidden');
    document.getElementById('ws-loading').classList.remove('hidden');
    document.getElementById('loading-title').textContent = "Neural Separation Active...";

    statusInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/jobs/${jobId}`);
            if (res.ok) {
                const job = await res.json();
                updateStatus(job.status); // Visual text

                if (job.status === 'completed') {
                    clearInterval(statusInterval);
                    localStorage.removeItem('active_stem_job');
                    showToast("Separation Complete!");
                    loadMixer(job.project.name, job.stems);
                    updateDashboard(); // Refresh grid
                } else if (job.status === 'failed') {
                    clearInterval(statusInterval);
                    localStorage.removeItem('active_stem_job');
                    showToast("Job Failed");
                    resetWorkspace();
                }
            }
        } catch (e) { console.error(e); }
    }, 2000);
}

function updateStatus(msg) {
    const el = document.getElementById('process-log-text'); // If exists
    if (el) el.textContent = msg;
}


// --- DASHBOARD / GRID ---
async function updateDashboard() {
    if (!currentUser) return;
    const grid = document.getElementById('projects-grid');
    if (!grid) return;

    const res = await fetch(`${API_BASE}/jobs/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (res.ok) {
        const jobs = await res.json();
        // Sort by date desc
        jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        grid.innerHTML = '';
        jobs.forEach(job => {
            const card = document.createElement('div');
            card.className = 'job-card';
            if (job.status === 'processing' || job.status === 'pending') card.classList.add('active-project');

            let statusBadge = '';
            if (job.status === 'completed') statusBadge = '<span class="badge success">Completed</span>';
            else if (job.status === 'failed') statusBadge = '<span class="badge error">Failed</span>';
            else statusBadge = '<span class="badge warning">Processing</span>';

            card.innerHTML = \`
                <div class="job-head">
                    <div class="job-icon"><i class="fa-solid fa-music"></i></div>
                    <div class="job-meta">
                         <h3>\${job.original_filename || 'Untitled'}</h3>
                         <span>\${new Date(job.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
                <div class="job-status">\${statusBadge}</div>
             \`;
             
             if(job.status === 'completed') {
                 card.onclick = () => loadMixer(job.original_filename, job.stems);
             }
             grid.appendChild(card);
        });
    }
}


// --- MIXER LOGIC (INSTANT PLAY + WAVESURFER) ---

// Modern Colors (Dracula/Cyberpunk)
const STEM_COLORS = {
    vocals: '#ff79c6', // Pink
    drums: '#ffb86c',  // Orange
    bass: '#8be9fd',   // Cyan
    other: '#bd93f9'   // Purple
};

let stemsWS = {}; // WaveSurfer instances
let isPlaying = false;
let seekerInterval = null;

function loadMixer(title, stems) {
    if (!stems) return;
    
    // UI Transition
    wsLoad.classList.add('hidden');
    wsDrop.classList.add('hidden');
    wsMixer.classList.remove('hidden');
    wsMixer.style.display = 'block';

    document.getElementById('project-title').textContent = title;

    // Reset Container
    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';
    
    // Reset Transport
    const playBtn = document.getElementById('play-btn');
    if(playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    isPlaying = false;
    
    const timeDisplay = document.getElementById('time-display');
    const durDisplay = document.getElementById('duration-display');
    const seekSlider = document.getElementById('seek-slider');
    
    if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = true; }
    if (timeDisplay) timeDisplay.textContent = "00:00";
    if (durDisplay) durDisplay.textContent = "00:00";

    stemsWS = {};
    const tpl = document.getElementById('channel-template');
    
    // Sort: Vocals, Drums, Bass, Instruments
    const sortOrder = ['vocals', 'drums', 'bass', 'other'];
    const sortedKeys = Object.keys(stems).sort((a,b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));

    // Master WS for event driving
    let masterWS = null;

    sortedKeys.forEach((name, index) => {
        const url = stems[name];
        
        // 1. Create Audio Element for INSTANT PLAYBACK
        const audioEl = new Audio();
        audioEl.src = url;
        audioEl.crossOrigin = 'anonymous';
        audioEl.preload = 'auto'; 
        
        // 2. Clone Strip
        const strip = tpl.content.cloneNode(true);
        const stripDiv = strip.querySelector('.channel-strip');
        
        // Styling...
        let displayName = name.toUpperCase();
        let color = STEM_COLORS.other;

        if (name === 'vocals') { color = STEM_COLORS.vocals; }
        if (name === 'drums' || name === 'percussion') { displayName = 'DRUMS'; color = STEM_COLORS.drums; }
        if (name === 'bass') { color = STEM_COLORS.bass; }
        if (name === 'other') { displayName = 'INSTRUMENTS'; color = STEM_COLORS.other; }

        strip.querySelector('.ch-name').textContent = displayName;
        strip.querySelector('.ch-name').style.color = color;
        stripDiv.style.borderLeft = \`4px solid \${color}\`;

        // Icons
        const iconDiv = strip.querySelector('.ch-icon');
        iconDiv.style.color = color;
        if(name === 'vocals') iconDiv.innerHTML = '<i class="fa-solid fa-microphone-lines"></i>';
        if(name.includes('drum')) iconDiv.innerHTML = '<i class="fa-solid fa-drum"></i>';
        if(name === 'bass') iconDiv.innerHTML = '<i class="fa-solid fa-wave-square"></i>';
        
        // Download Button (New Location)
        const dlBtn = document.createElement('a');
        dlBtn.href = url;
        dlBtn.download = \`\${title}-\${name}.wav\`;
        dlBtn.className = 'ch-download-btn';
        dlBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
        dlBtn.title = 'Download Stem';
        
        // Append DL Button to controls
        const controlsDiv = strip.querySelector('.ch-controls');
        controlsDiv.appendChild(dlBtn);

        // Prep WaveSurfer Container
        const canvas = strip.querySelector('canvas');
        const visualizerContainer = document.createElement('div');
        visualizerContainer.className = 'ws-waveform-container';
        visualizerContainer.id = \`ws-\${name}\`;
        if(canvas) canvas.replaceWith(visualizerContainer);

        container.appendChild(stripDiv);

        // 3. Init WaveSurfer with MEDIA ELEMENT
        // This is crucial for Instant Play + Large File support
        const ws = WaveSurfer.create({
            container: \`#ws-\${name}\`,
            waveColor: color,
            progressColor: '#ffffff',
            cursorColor: '#ffffff',
            cursorWidth: 2,
            barWidth: 3,
            barGap: 2,
            barRadius: 2,
            height: 60,
            normalize: true,
            media: audioEl, // <--- BIND TO AUDIO ELEMENT
            fetchParams: {
                mode: 'cors',
            },
        });

        // Store
        stemsWS[name] = { ws, audio: audioEl, muted: false };

        // 4. Events
        ws.on('ready', () => {
             // Set duration once active
             if(index === 0) {
                 const dur = ws.getDuration();
                 const m = Math.floor(dur / 60);
                 const s = Math.floor(dur % 60).toString().padStart(2, '0');
                 durDisplay.textContent = \`\${m}:\${s}\`;
                 seekSlider.max = dur;
                 seekSlider.disabled = false;
             }
        });
        
        // Sync Seeking
        ws.on('interaction', (newTime) => {
             Object.values(stemsWS).forEach(s => {
                 if(s.ws !== ws) s.ws.setTime(newTime);
             });
             seekSlider.value = newTime;
        });

        // Mute/Solo
        const mBtn = stripDiv.querySelector('.mute');
        mBtn.onclick = () => {
            const track = stemsWS[name];
            track.muted = !track.muted;
            mBtn.classList.toggle('active', track.muted);
            track.ws.setVolume(track.muted ? 0 : 1);
        };
        
        const sBtn = stripDiv.querySelector('.solo');
        sBtn.innerHTML = '<i class="fa-solid fa-headphones"></i>';
        sBtn.onclick = () => {
             const isSolo = sBtn.classList.contains('active');
             document.querySelectorAll('.solo').forEach(b => b.classList.remove('active'));
             
             if(isSolo) {
                 // Unsolo
                 Object.values(stemsWS).forEach(t => t.ws.setVolume(t.muted ? 0 : 1));
             } else {
                 // Solo
                 sBtn.classList.add('active');
                 Object.values(stemsWS).forEach(t => {
                     t.ws.setVolume(t === stemsWS[name].ws ? 1 : 0);
                 });
             }
        };

        if(index === 0) masterWS = ws;
    });

    // Transport Listeners
    if(masterWS) {
        masterWS.on('audioprocess', (t) => {
            seekSlider.value = t;
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60).toString().padStart(2, '0');
            timeDisplay.textContent = \`\${m}:\${s}\`;
        });
        
        masterWS.on('finish', () => {
            isPlaying = false;
            playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        });
    }

    // Play Button Logic
    playBtn.onclick = () => {
        if(isPlaying) {
            Object.values(stemsWS).forEach(s => s.ws.pause());
            isPlaying = false;
            playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        } else {
            Object.values(stemsWS).forEach(s => s.ws.play());
            isPlaying = true;
            playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        }
    };
    
    // Slider Logic
    seekSlider.oninput = (e) => {
        const t = parseFloat(e.target.value);
        Object.values(stemsWS).forEach(s => s.ws.setTime(t));
    };
}

// Close/Download helpers
function closeMixer() {
    isPlaying = false;
    Object.values(stemsWS).forEach(s => s.ws.destroy()); // Stops audio too
    stemsWS = {};
    wsMixer.classList.add('hidden');
    // Refresh Library
    updateDashboard();
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.classList.add('visible'), 100);
    setTimeout(() => {
        t.classList.remove('visible');
        setTimeout(() => t.remove(), 300);
    }, 3000);
}
