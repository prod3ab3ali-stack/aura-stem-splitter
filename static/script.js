// --- Global State ---
let authToken = localStorage.getItem('aura_token');
let currentUser = null;

// --- Global Theme Function ---
function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    // Update active button state
    document.querySelectorAll('.theme-opt').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(mode)) btn.classList.add('active');
    });
    // Persist
    localStorage.setItem('aura_theme', mode);
}

let audioContext = null;
let masterGain = null;
let stemsAudio = {}; // For Workspace
let demoAudio = {}; // For Landing Demo
let masterState = 'stopped';
let currentTheme = localStorage.getItem('aura_theme') || 'light';

const API_BASE = '/api';

// --- DOM References ---
const viewLanding = document.getElementById('view-landing');
const viewApp = document.getElementById('view-app');
const authShade = document.getElementById('auth-shade');
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
    initCursor();
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
        // Force Switch to App View if not already
        if (document.getElementById('view-app').classList.contains('hidden')) {
            switchView('app');
        }

        // Restore UI state
        const wsDrop = document.getElementById('ws-drop');
        const wsLoad = document.getElementById('ws-loading');

        if (wsDrop && wsLoad) {
            wsDrop.classList.add('hidden');
            wsLoad.classList.remove('hidden');
            startJobPolling(activeJobId);
        }
    } else {
        // Normal Load
        if (currentUser) loadLibrary();
    }

    // 3. Parallax Effect
    document.addEventListener('mousemove', (e) => {
        const x = (window.innerWidth - e.pageX * 2) / 100;
        const y = (window.innerHeight - e.pageY * 2) / 100;

        // Move Background Elements
        const bg = document.querySelector('.workspace-center');
        if (bg) {
            bg.style.backgroundPosition = `${x}px ${y} px, ${x * 0.5 + 15}px ${y * 0.5 + 15} px`;
        }
    });

    // Mobile Menu
    const menuBtn = document.getElementById('menu-btn');
    if (menuBtn) menuBtn.onclick = () => {
        document.querySelector('.mobile-menu').classList.toggle('active');
    }

    // Input file listener
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.onchange = e => { if (e.target.files.length) processFile(e.target.files[0]); };
});

// --- View Logic ---
function switchInput(mode) {
    const vFile = document.getElementById('view-file');
    const vTube = document.getElementById('view-youtube');
    const btns = document.querySelectorAll('.tab-btn');

    // Toggle Active State
    btns[0].classList.toggle('active', mode === 'file');
    btns[1].classList.toggle('active', mode === 'youtube');

    // Fade Transition
    const fadeOut = (el) => {
        el.style.opacity = '0';
        setTimeout(() => el.classList.add('hidden'), 200);
    };
    const fadeIn = (el) => {
        el.classList.remove('hidden');
        setTimeout(() => el.style.opacity = '1', 10);
    };

    if (mode === 'file') {
        fadeOut(vTube);
        setTimeout(() => fadeIn(vFile), 200);
        document.getElementById('yt-url-input').value = ''; // Clean
    } else {
        fadeOut(vFile);
        setTimeout(() => fadeIn(vTube), 200);
    }
}

// Shared Polling Logic
function startJobPolling(job_id) {
    // 1. Persist ID
    localStorage.setItem('active_stem_job', job_id);

    const startTime = Date.now();
    const timerEl = document.getElementById('process-timer');

    // Timer Loop
    const timerInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.textContent = `${mins}:${secs} `;
    }, 1000);

    // Status Poll Loop
    const poll = setInterval(async () => {
        // Check if job still valid? 
        // If server restarts, this might 404. Handle that.
        try {
            const statusRes = await fetch(`${API_BASE}/jobs/${job_id}`);

            if (statusRes.status === 404) {
                clearInterval(poll);
                clearInterval(timerInterval);
                localStorage.removeItem('active_stem_job'); // Clear invalid
                showToast("Job lost (Server Restarted)");
                resetWorkspace();
                return;
            }

            const job = await statusRes.json();

            if (job.status === 'failed') {
                clearInterval(poll);
                clearInterval(timerInterval);
                localStorage.removeItem('active_stem_job'); // Done
                showToast("Job Failed: " + job.error);
                resetWorkspace();
                return;
            }

            if (job.status === 'completed') {
                clearInterval(poll);
                clearInterval(timerInterval);
                localStorage.removeItem('active_stem_job'); // Done

                const data = job.result;
                updateCredits(data.credits_left);

                // UX: Show success state briefly before redirect
                const titleEl = document.getElementById('loading-title');
                if (titleEl) {
                    titleEl.textContent = "Production Ready!";
                    titleEl.style.color = "var(--success)";
                }
                const borderEl = document.querySelector('.workspace-center');
                if (borderEl) borderEl.classList.add('success');

                // Force Redirect after 1s
                setTimeout(() => {
                    try {
                        loadMixer(data.project.name, data.stems);
                        loadLibrary();
                    } catch (e) {
                        console.error("Redirect Error", e);
                        showToast("Error opening project: " + e.message);
                        // Fallback
                        wsLoad.classList.add('hidden');
                        wsMixer.classList.remove('hidden');
                    }
                }, 1000);

                return;
            }

            // Update Logs
            updateStatus(job.status);
            const titleEl = document.getElementById('loading-title');
            if (titleEl) titleEl.textContent = job.status.split('...')[0];

            // Update Progress Bar
            if (job.status.includes('Downloading')) {
                document.getElementById('upload-progress-container').classList.remove('hidden');
                document.getElementById('upload-bar').style.width = job.progress + "%";
                document.getElementById('upload-percent').textContent = Math.round(job.progress) + "%";
            } else {
                document.getElementById('upload-progress-container').classList.add('hidden');
            }
        } catch (e) {
            console.error("Poll Error", e);
        }

    }, 1000);
}

// --------------------------------------------------------

async function processUrl() {
    const input = document.getElementById('yt-url-input');
    const url = input.value.trim();
    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;

    if (!url) return showToast("Please enter a URL");
    if (!ytRegex.test(url)) return showToast("Invalid YouTube URL");

    // Switch UI
    document.getElementById('ws-drop').classList.add('hidden');
    document.getElementById('ws-loading').classList.remove('hidden');

    // Reset Log & Timer
    document.getElementById('processing-log').innerHTML = '';
    const timerEl = document.getElementById('process-timer');
    if (timerEl) timerEl.textContent = "00:00";

    const formData = new FormData();
    formData.append("url", url);

    try {
        const res = await fetch(`${API_BASE}/process_youtube_async`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` },
            body: formData
        });

        if (!res.ok) throw new Error("Failed to start job");
        const { job_id } = await res.json();

        startJobPolling(job_id);

    } catch (e) {
        showToast("Error: " + e.message);
        resetWorkspace();
    }
}

// --------------------------------------------------------

async function processFile(file) {
    if (!currentUser) { showToast("Please login first"); return; }

    const wsDrop = document.getElementById('ws-drop');
    const wsLoad = document.getElementById('ws-loading');

    wsDrop.classList.add('hidden');
    wsLoad.classList.remove('hidden');

    // Reset Log & Timer
    document.getElementById('processing-log').innerHTML = '';
    const timerEl = document.getElementById('process-timer');
    if (timerEl) timerEl.textContent = "00:00";

    document.getElementById('loading-title').textContent = "Uploading Master...";
    document.getElementById('upload-progress-container').classList.remove('hidden');

    const formData = new FormData();
    formData.append("file", file);

    // We use fetch here because we want the JSON response
    // For Upload Progress, we could use XHR, but let's simplify to standard fetch 
    // and rely on fast local network or assume fast upload for now to switch to job faster.
    // Actually, XHR for upload progress is better UX.

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
            // Switch to Job Polling
            document.getElementById('upload-progress-container').classList.add('hidden');
            startJobPolling(data.job_id);
        } else {
            showToast("Upload Failed");
            resetWorkspace();
        }
    };

    xhr.send(formData);
}

// --- Theme Logic ---
const themeBtn = document.getElementById('theme-btn');
if (themeBtn) themeBtn.onclick = () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
};

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('aura_theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = theme === 'light' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
}

// --- Cursor Follower ---
function initCursor() {
    const cur = document.getElementById('cursor-follower');
    if (!cur) return;
    document.addEventListener('mousemove', e => {
        // Use requestAnimationFrame for smoother following if needed, but simple transform is fine
        cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
    });
}

// --- Hero Visuals (Canvas) ---
function initHeroVisuals() {
    const cvs = document.getElementById('hero-canvas');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    let w, h;

    function resize() {
        w = cvs.width = window.innerWidth;
        h = cvs.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    let time = 0;
    function loop() {
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = currentTheme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;

        for (let i = 0; i < 8; i++) {
            ctx.beginPath();
            let y = h / 2 + Math.sin(time + i) * 80;
            ctx.moveTo(0, y);

            for (let x = 0; x < w; x += 30) {
                let ny = y + Math.sin(x * 0.003 + time + i * 0.5) * 60;
                ctx.lineTo(x, ny);
            }
            ctx.stroke();
        }
        time += 0.005;
        requestAnimationFrame(loop);
    }
    loop();
}

// --- Scroll Observer ---
function initScrollObs() {
    const obs = new IntersectionObserver(entries => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                e.target.classList.add('visible');
                // Don't unobserve if we want repeat triggers, but usually one-time is good
                obs.unobserve(e.target);
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.fade-in').forEach(el => obs.observe(el));
}

// --- Interactive Demo (Landing) ---
/* Visual Simulation */
let isDemoPlaying = false;
function initDemoPlayer() {
    const cvs = document.getElementById('demo-canvas');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    const playBtn = document.getElementById('demo-play-btn');
    const toggles = document.querySelectorAll('.stem-toggle');

    if (playBtn) playBtn.onclick = () => {
        isDemoPlaying = !isDemoPlaying;
        playBtn.classList.toggle('playing', isDemoPlaying);
        if (isDemoPlaying) animateDemoViz(ctx, cvs);
    };

    toggles.forEach(t => {
        t.onclick = () => {
            t.classList.toggle('muted');
        }
    });
}
function animateDemoViz(ctx, cvs) {
    if (!isDemoPlaying) { ctx.clearRect(0, 0, cvs.width, cvs.height); return; }

    function loop() {
        if (!isDemoPlaying) return;
        requestAnimationFrame(loop);

        ctx.clearRect(0, 0, cvs.width, cvs.height);

        // Draw bands based on active stems
        const bands = document.querySelectorAll('.stem-toggle:not(.muted)');
        if (bands.length === 0) return;

        const sectionH = cvs.height / 4;
        ctx.fillStyle = currentTheme === 'light' ? '#000' : '#fff';

        bands.forEach((b, i) => {
            const rowBase = (i + 1) * 30; // offset pseudo-randomly
            const yCenter = (cvs.height / 2) + (Math.sin(Date.now() * 0.002 + i) * 20);

            for (let x = 0; x < cvs.width; x += 6) {
                const h = Math.abs(Math.sin(x * 0.05 + Date.now() * 0.01)) * 40 * Math.random();
                ctx.fillRect(x, yCenter - h / 2, 4, h);
            }
        });
    }
    cvs.width = cvs.clientWidth;
    cvs.height = cvs.clientHeight;
    loop();
}
function scrollToDemo() {
    document.getElementById('demo').scrollIntoView({ behavior: 'smooth' });
}

const state = {
    view: 'landing', // landing, app
    pane: 'workspace', // workspace, library, store, admin, settings
    user: null,
    token: null,
    activeJob: null
};

// --- AUTHENTICATION ---

async function toggleAuth(mode) {
    const shade = document.getElementById('auth-shade');
    const sidebar = document.getElementById('auth-sidebar');
    const title = document.getElementById('auth-title');
    const msg = document.getElementById('auth-msg');
    const tog = document.getElementById('auth-tog');
    const emailGroup = document.getElementById('auth-email-group');

    shade.style.display = 'block';
    setTimeout(() => {
        shade.style.opacity = '1';
        sidebar.classList.add('open');
    }, 10);

    // Reset Form
    document.getElementById('auth-form').reset();

    if (mode === 'login') {
        title.textContent = 'Welcome Back';
        msg.textContent = 'New here?';
        tog.textContent = 'Create Account';
        tog.setAttribute('onclick', "toggleAuth('signup')");
        document.getElementById('auth-submit').textContent = 'Log In';
        document.getElementById('auth-form').dataset.mode = 'login';
        if (emailGroup) emailGroup.style.display = 'none';
    } else {
        title.textContent = 'Create Account';
        msg.textContent = 'Already have an account?';
        tog.textContent = 'Log In';
        tog.setAttribute('onclick', "toggleAuth('login')");
        document.getElementById('auth-submit').textContent = 'Sign Up';
        document.getElementById('auth-form').dataset.mode = 'signup';
        if (emailGroup) emailGroup.style.display = 'block';
    }
}

function closeAuth() {
    const shade = document.getElementById('auth-shade');
    const sidebar = document.getElementById('auth-sidebar');
    shade.style.opacity = '0';
    sidebar.classList.remove('open');
    setTimeout(() => shade.style.display = 'none', 300);
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.target.dataset.mode;
    const userIn = document.getElementById('auth-user').value;
    const passIn = document.getElementById('auth-pass').value;
    const emailIn = document.getElementById('auth-email') ? document.getElementById('auth-email').value : "";

    const btn = document.getElementById('auth-submit');
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const endpoint = mode === 'login' ? '/api/login' : '/api/signup';
        const payload = { username: userIn, password: passIn, email: emailIn };

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok) {
            if (mode === 'signup') {
                showToast('Account created! Logging in...');
                await new Promise(r => setTimeout(r, 1000));
                // Auto login
                const loginRes = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: userIn, password: passIn })
                });
                const loginData = await loginRes.json();
                handleLoginSuccess(loginData);
            } else {
                handleLoginSuccess(data);
            }
            closeAuth();
        } else {
            showToast(data.detail || 'Error');
        }
    } catch (err) {
        showToast('Connection Error');
        console.error(err);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

// --- 1. Login Success Handler (Fixed) ---
function handleLoginSuccess(data) {
    // 1. Update New State
    state.token = data.token;
    state.user = data.user;

    // 2. Sync Legacy Globals (Crucial for loadLibrary/fetchUser)
    authToken = data.token;
    currentUser = data.user;

    // 3. Persist
    localStorage.setItem('aura_token', data.token);

    // 4. Update UI (Pass user object!)
    updateUI(state.user);

    // 5. Navigate
    switchView('app');
    loadLibrary(); // Now works because authToken is set
    showToast(`Welcome, ${state.user.username}`);

    // Synced Inputs
    if (state.user.email) document.getElementById('set-email').value = state.user.email;
    document.getElementById('set-username').value = state.user.username;
}

// --- View Switching ---
async function fetchUser() {
    try {
        // Use state.token or authToken
        const t = state.token || authToken;
        if (!t) throw new Error("No Token");

        const res = await fetch(`${API_BASE}/me`, { headers: { 'Authorization': `Bearer ${t}` } });
        if (!res.ok) throw new Error("Session Invalid");

        const u = await res.json();

        // Sync State
        state.user = u;
        currentUser = u;

        updateUI(u);
        switchView('app');
    } catch (e) {
        // Only show toast if we actually had a token and it failed
        if (localStorage.getItem('aura_token')) {
            showToast("Session expired. Please log in.");
        }
        logout();
    }
}

// (Removed duplicate updateUI function from here)

function switchView(name) {
    // Force clean state
    if (name === 'landing') {
        viewApp.classList.add('hidden');
        viewLanding.classList.remove('hidden');

        // Ensure display properties overlap is fixed by CSS .hidden, but let's be safe
        viewApp.style.display = 'none';
        viewLanding.style.display = 'block';

        // Reset landing state
        setTimeout(() => viewLanding.classList.add('active'), 10);
    } else {
        // Enforce login for app view
        if (!currentUser) {
            switchView('landing');
            return;
        }

        viewLanding.classList.add('hidden');
        viewApp.classList.remove('hidden');

        viewLanding.style.display = 'none';
        viewApp.style.display = 'block';

        setTimeout(() => viewApp.classList.add('active'), 10);
        navTo('workspace'); // Default tab
    }
}

function logout() {
    authToken = null;
    localStorage.removeItem('aura_token');
    currentUser = null;
    switchView('landing');

    // Reset form
    document.getElementById('auth-user').value = '';
    document.getElementById('auth-pass').value = '';
}

// --- Workspace Navigation ---
function navTo(page) {
    if (!currentUser) return; // Guard

    // Hide all panes
    document.querySelectorAll('.pane').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none'; // Explicit
    });

    // Sidebar active state
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    // Find button
    const btns = document.querySelectorAll('.nav-btn');
    if (page === 'workspace') btns[0].classList.add('active');
    if (page === 'library') btns[1].classList.add('active');
    if (page === 'store') btns[2].classList.add('active');
    if (page === 'admin') btns[3].classList.add('active');

    // Show pane
    const pane = document.getElementById(`pane-${page}`);
    if (pane) {
        pane.style.display = 'block';
        setTimeout(() => pane.classList.add('active'), 10);
    }

    // Dynamic Loads
    if (page === 'library') loadLibrary();
    if (page === 'admin') loadAdmin();
}

// --- App Logic (Mixer) ---
// State for animations
let statusInterval = null;

function updateStatus(text) {
    const log = document.getElementById('processing-log');
    // Slide out old
    const old = log.querySelector('.active');
    if (old) {
        old.classList.remove('active');
        old.classList.add('done');
        setTimeout(() => old.remove(), 500);
    }
    // Slide in new
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = text;
    log.appendChild(item);

    // Trigger reflow
    void item.offsetWidth;
    item.classList.add('active');
}

function startProcessingLoop() {
    const steps = [
        "Analyzing Audio Structure...",
        "Identifying Stems...",
        "Applying Neural Filter...",
        "Removing Artifacts...",
        "Enhancing Transient Detail...",
        "Finalizing Stems..."
    ];
    let i = 0;
    statusInterval = setInterval(() => {
        updateStatus(steps[i++ % steps.length]);
    }, 4000);
}

const wsDrop = document.getElementById('ws-drop');
const wsLoad = document.getElementById('ws-loading');
const wsMixer = document.getElementById('ws-mixer');

function resetWorkspace() {
    stopPlayback();
    // Reset visibility driven by classes
    if (wsDrop) {
        wsDrop.classList.remove('hidden');
        wsDrop.style.display = '';
    }
    if (wsLoad) {
        wsLoad.classList.add('hidden');
        wsLoad.style.display = '';
    }
    if (wsMixer) {
        wsMixer.classList.add('hidden');
        wsMixer.style.display = '';
    }
}

function processFile(file) {
    if (!currentUser) { showToast("Please login first"); return; }

    // Reset UI
    wsDrop.classList.add('hidden');
    wsLoad.classList.remove('hidden');
    document.getElementById('loading-title').textContent = "Uploading Master...";
    document.getElementById('upload-progress-container').classList.remove('hidden');

    // Use XHR for Upload Progress
    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/process`, true);
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
            clearInterval(statusInterval);
            const data = JSON.parse(xhr.responseText);
            updateUI({ ...currentUser, credits: data.credits_left }); // Update credits in UI
            showToast("Success!");
            loadMixer(data.project.name, data.stems);
            loadLibrary(); // Sync library instantly
        } else {
            clearInterval(statusInterval);
            showToast("Processing Failed");
            resetWorkspace();
        }
    };

    xhr.onerror = () => {
        clearInterval(statusInterval);
        showToast("Network Error");
        resetWorkspace();
    };

    // Start Simulation of processing while backend runs
    xhr.upload.onloadend = () => {
        // Upload done, now processing
        document.getElementById('loading-title').textContent = "Processing Audio...";
        document.getElementById('upload-progress-container').classList.add('hidden');
        updateStatus("Initializing Neural Engine...");
        startProcessingLoop();
    };

    xhr.send(formData);
}

// --- MIXER AUDIO GRAPH ---
const FX = {
    reverb: null,
    spatial: null,
    masterCompressor: null
};

// Simple Reverb Impulse (Synthetic)
async function createReverb(ctx) {
    const len = ctx.sampleRate * 2.0;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
            ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
        }
    }
    const node = ctx.createConvolver();
    node.buffer = buf;

    // Wet/Dry Mix
    const input = ctx.createGain();
    const wet = ctx.createGain();
    const dry = ctx.createGain();
    const out = ctx.createGain();

    input.connect(dry);
    input.connect(wet);
    wet.connect(node);

    dry.connect(out);
    node.connect(out);

    wet.gain.value = 0; // Off by default
    dry.gain.value = 1;

    return { input, out, wet };
}

async function initMasterFX(ctx) {
    // Spatial (Stereo Widener)
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const delayL = ctx.createDelay();
    const delayR = ctx.createDelay();

    // Simple Haas effect
    delayL.delayTime.value = 0;
    delayR.delayTime.value = 0.010; // 10ms for wide feel

    const spatialIn = ctx.createGain();
    const spatialOut = ctx.createGain();
    // Default pass-through
    spatialIn.connect(spatialOut);

    // Logic for toggle
    FX.spatial = {
        node: spatialIn,
        toggle: (active) => {
            spatialIn.disconnect();
            if (active) {
                // Engage widener
                spatialIn.connect(splitter);
                splitter.connect(delayL, 0);
                splitter.connect(delayR, 1);
                delayL.connect(merger, 0, 0);
                delayR.connect(merger, 0, 1);
                merger.connect(spatialOut);
            } else {
                spatialIn.connect(spatialOut);
            }
        }
    };

    // Reverb
    const rev = await createReverb(ctx);
    FX.reverb = rev;

    // Chain: MasterGain -> Spatial -> Reverb -> Dest
    masterGain.disconnect();
    masterGain.connect(FX.spatial.node);
    spatialOut.connect(rev.input);
    rev.out.connect(ctx.destination);
}

// UI Toggles
function toggleFX(type) {
    const btn = document.getElementById(`btn-${type}`);
    const isActive = btn.classList.toggle('active');

    if (type === 'spatial' && FX.spatial) FX.spatial.toggle(isActive);
    if (type === 'reverb' && FX.reverb) FX.reverb.wet.gain.setTargetAtTime(isActive ? 0.4 : 0, audioContext.currentTime, 0.2);
}

// --- Mix Logic ---
async function downloadZip(projectId) {
    if (!projectId) return showToast("Project ID missing");
    window.location.href = `${API_BASE}/download_zip/${projectId}`;
}

function closeMixer() {
    // Stop Audio
    if (audioContext) audioContext.suspend();
    Object.values(stemsAudio || {}).forEach(s => s.audio.pause());

    wsMixer.classList.add('hidden');
    // Reload Library to ensure fresh state
    loadLibrary();
}

function loadMixer(title, stems) {
    if (!stems) return;

    // Find project ID from stems path or just use title if needed?
    // Stems dict values are like "/stems/htdemucs_6s/{UUID}/{stem}.wav"
    // Extract UUID
    const firstStem = Object.values(stems)[0];
    const projectId = firstStem.split('/')[3];

    wsLoad.classList.add('hidden');
    wsDrop.classList.add('hidden');
    wsMixer.classList.remove('hidden');
    wsMixer.style.display = 'block';

    const titleEl = document.getElementById('project-title');
    if (titleEl) titleEl.textContent = title;

    // Setup ZIP Button
    const zipBtn = document.getElementById('btn-zip-download');
    if (zipBtn) {
        zipBtn.onclick = () => downloadZip(projectId);
        // Clean Text
        zipBtn.innerHTML = '<i class="fa-solid fa-file-zipper"></i> Download Stems';
    }

    // Setup Close Button
    const closeBtn = document.getElementById('btn-close-mixer');
    if (closeBtn) closeBtn.onclick = closeMixer;

    const container = document.getElementById('mixer-channels');
    container.innerHTML = '';

    // Audio Context
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioContext.createGain();
        initMasterFX(audioContext); // Setup FX Chain
    } else {
        masterGain.disconnect();
        // Re-route if existing
        if (FX.spatial) masterGain.connect(FX.spatial.node);
        else masterGain.connect(audioContext.destination);
    }

    if (audioContext.state === 'suspended') audioContext.resume();

    stemsAudio = {};
    const tpl = document.getElementById('channel-template');

    Object.entries(stems).forEach(([name, url]) => {
        const audio = new Audio(url);
        audio.crossOrigin = 'anonymous';
        audio.loop = true;

        const src = audioContext.createMediaElementSource(audio);
        const gain = audioContext.createGain();
        const anal = audioContext.createAnalyser();
        anal.fftSize = 64;

        src.connect(gain);
        gain.connect(anal);
        gain.connect(masterGain);

        stemsAudio[name] = { audio, gain, anal, muted: false };

        // UI
        const strip = tpl.content.cloneNode(true);

        let displayName = name.toUpperCase();
        if (name === 'other') displayName = 'SYNTH / FX';
        if (name === 'drums') displayName = 'PERCUSSION'; // As requested

        strip.querySelector('.ch-name').textContent = displayName;
        strip.querySelector('a').href = url;

        // Special highlighting for Synths
        if (name === 'other') {
            strip.querySelector('.ch-name').style.color = '#A855F7'; // Purple
        }

        // Mute
        const mBtn = strip.querySelector('.mute');
        mBtn.onclick = () => {
            stemsAudio[name].muted = !stemsAudio[name].muted;
            mBtn.classList.toggle('active', stemsAudio[name].muted);
            gain.gain.value = stemsAudio[name].muted ? 0 : 1;
        };

        // Solo
        const sBtn = strip.querySelector('.solo');
        sBtn.onclick = () => {
            const isSolo = sBtn.classList.contains('active');
            document.querySelectorAll('.solo').forEach(b => b.classList.remove('active'));

            if (isSolo) {
                Object.values(stemsAudio).forEach(t => t.gain.gain.value = 1);
            } else {
                sBtn.classList.add('active');
                Object.entries(stemsAudio).forEach(([k, t]) => {
                    t.gain.gain.value = k === name ? 1 : 0;
                });
            }
        };

        // Fader
        const fader = strip.querySelector('.ch-fader');
        if (fader) fader.oninput = e => {
            if (!stemsAudio[name].muted) gain.gain.value = e.target.value;
        };

        // Visualizer
        const cvs = strip.querySelector('canvas');
        if (cvs) drawChanVis(cvs, anal);

        container.appendChild(strip);
    });
}

function drawChanVis(cvs, anal) {
    const ctx = cvs.getContext('2d');
    function draw() {
        if (wsMixer.style.display === 'none') return;
        requestAnimationFrame(draw);

        const w = cvs.width = cvs.clientWidth;
        const h = cvs.height = cvs.clientHeight;
        const data = new Uint8Array(anal.frequencyBinCount);
        anal.getByteFrequencyData(data);

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = currentTheme === 'light' ? '#000' : '#fff';

        const barW = (w / data.length) * 2;
        let x = 0;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 255;
            ctx.fillRect(x, h - v * h, barW, v * h);
            x += barW + 1;
        }
    }
    draw();
}

// Transport
const playBtn = document.getElementById('play-btn');
if (playBtn) playBtn.onclick = () => {
    if (masterState === 'playing') {
        Object.values(stemsAudio).forEach(s => s.audio.pause());
        masterState = 'paused';
        playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    } else {
        Object.values(stemsAudio).forEach(s => s.audio.play());
        masterState = 'playing';
        playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    }
};

const stopBtn = document.getElementById('stop-btn');
if (stopBtn) stopBtn.onclick = stopPlayback;

function stopPlayback() {
    if (Object.keys(stemsAudio).length === 0) return;
    Object.values(stemsAudio).forEach(s => {
        s.audio.pause();
        s.audio.currentTime = 0;
    });
    masterState = 'stopped';
    if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
}

// --- Library & Admin ---
async function loadLibrary() {
    const box = document.getElementById('library-list');
    if (!box) return;
    box.style.display = 'grid'; // Restore grid
    box.style.border = 'none';
    box.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:var(--text-sec); padding: 40px;">Syncing Library...</p>';

    setTimeout(async () => {
        try {
            // Auto-sync
            await fetch(`${API_BASE}/sync`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });

            // Cache bust
            const t = new Date().getTime();
            const res = await fetch(`${API_BASE}/history?t=${t}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (res.status === 401) { logout(); return; }

            const data = await res.json();
            const projectCount = data.projects ? data.projects.length : 0;

            // --- VISUAL DEBUG START ---
            // Remove this block after confirming it works
            // console.log("Library Data:", data);
            // --- VISUAL DEBUG END ---

            box.innerHTML = '';

            if (projectCount === 0) {
                box.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; border: 2px dashed var(--border); border-radius: 20px;">
                <i class="fa-solid fa-cloud-upload" style="font-size: 2rem; margin-bottom: 20px; color: var(--text-sec)"></i>
                <p>No projects found.</p>
                <small style="color:var(--text-sec); display:block; margin-top:10px;">ID: ${currentUser?.id}</small>
                <button onclick="createTestProject()" style="margin-top:20px; background:var(--bg-surface); border:1px solid var(--border); padding:8px 16px; border-radius:8px; cursor:pointer;">
                    <i class="fa-solid fa-bug"></i> Generate Test Project
                </button>
            </div>`;
                return;
            }

            data.projects.forEach(p => {
                // Safe Date Parsing
                let dateStr = "Unknown Date";
                try {
                    // Fix SQL date format for JS (replace space with T)
                    const safeDate = p.date.replace(" ", "T");
                    dateStr = new Date(safeDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                } catch (e) { }

                const stemsCount = p.stems ? Object.keys(p.stems).length : 0;
                const isValid = stemsCount > 0;

                const div = document.createElement('div');
                div.className = 'lib-item';
                if (!isValid) div.style.opacity = '0.6';

                div.innerHTML = `
                <div class="lib-cover">
                    <i class="fa-solid fa-record-vinyl"></i>
                </div>
                <div class="delete-btn" title="Delete Project" onclick="deleteProject(event, '${p.id}')">
                    <i class="fa-solid fa-trash"></i>
                </div>
                <div class="lib-meta">
                    <div class="lib-title">${p.name}</div>
                    <span class="lib-date">${dateStr}</span>
                    <div class="lib-tags">
                        <span class="tag">${stemsCount} STEMS</span>
                        <span class="tag">${isValid ? 'READY' : 'ERROR'}</span>
                    </div>
                </div>
             `;
                div.onclick = (e) => {
                    if (!e.target.closest('.delete-btn') && isValid) {
                        navTo('workspace'); loadMixer(p.name, p.stems);
                    }
                };
                box.appendChild(div);
            });
        } catch (e) {
            console.error(e);
            box.innerHTML = '<p style="text-align:center; color:red">Error loading library. Please refresh.</p>';
        }
    }, 100); // Small delay to let initial render happen
}

async function createTestProject() {
    try {
        const res = await fetch(`${API_BASE}/debug/test_project`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            showToast("Test Project Created");
            loadLibrary();
        } else {
            showToast("Failed to create test project");
        }
    } catch (e) { console.error(e); }
}

async function deleteProject(e, pid) {
    if (!confirm("Are you sure you want to delete this project? This action cannot be undone.")) return;

    // Stop event propagation to prevent the parent card's click handler from firing
    e.stopPropagation();

    try {
        const res = await fetch(`${API_BASE}/projects/${pid}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            showToast("Project Deleted");
            loadLibrary();
        } else {
            showToast("Error Deleting");
        }
    } catch (err) { showToast(err.message); }
}

async function loadAdmin() {
    const table = document.getElementById('admin-list');
    if (!table) return;
    try {
        const res = await fetch(`${API_BASE}/admin/users`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        table.innerHTML = data.users.map(u => `<tr><td>${u.username}</td><td>${u.credits}</td><td>${u.plan}</td></tr>`).join('');
    } catch (e) { table.innerHTML = 'Access Denied'; }
}

// --- Payment System ---
let selectedPlan = null;

function handleSubscribe(plan) {
    if (!currentUser) return toggleAuth('signup');
    if (currentUser.plan === plan) return showToast("You are already on this plan");

    if (plan === 'free') {
        // Downgrade immediately
        subscribe(plan);
    } else {
        // Show Payment
        selectedPlan = plan;
        const modal = document.getElementById('payment-modal');
        document.getElementById('pay-plan-name').textContent = plan === 'pro' ? 'Creator' : 'Studio';
        document.getElementById('pay-amount').textContent = plan === 'pro' ? '$15.00' : '$29.00';
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
}

function handleLandingSubscribe(plan) {
    if (!currentUser) {
        toggleAuth('signup');
        // Optional: save intended plan to localstorage to auto-pop later
        return;
    }
    navTo('store');
    handleSubscribe(plan);
}

function closePaymentModal() {
    document.getElementById('payment-modal').classList.add('hidden');
    document.getElementById('payment-modal').style.display = 'none';
}

function processPayment() {
    const btn = document.getElementById('btn-pay-confirm');
    const original = btn.innerHTML;

    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Processing...';
    btn.disabled = true;

    setTimeout(async () => {
        try {
            // Simulate Payment Success
            await subscribe(selectedPlan);
            closePaymentModal();
            showToast("Payment Successful! Welcome to " + selectedPlan);

            // Confetti or visual cue could go here

        } catch (e) {
            showToast("Payment Failed");
        } finally {
            btn.innerHTML = original;
            btn.disabled = false;
        }
    }, 2000);
}

// Override Utils
function updateUI(user) {
    document.getElementById('display-username').textContent = user.username;
    document.getElementById('credit-count').textContent = user.credits;
    const adminNav = document.getElementById('nav-admin');
    if (adminNav) adminNav.style.display = user.is_admin ? 'flex' : 'none';

    // Update Plan Buttons
    const marks = { 'free': 'btn-plan-free', 'pro': 'btn-plan-pro', 'studio': 'btn-plan-studio' };

    Object.keys(marks).forEach(p => {
        const btn = document.getElementById(marks[p]);
        if (btn) {
            if (user.plan === p) {
                btn.textContent = "Current Plan";
                btn.className = "btn-outline";
                btn.disabled = true;
            } else {
                btn.textContent = "Upgrade";
                btn.className = p === 'free' ? "btn-outline" : "btn-primary";
                btn.disabled = false;
            }
        }
    });
}

async function subscribe(p) {
    try {
        await fetch(`${API_BASE}/subscribe?plan=${p}`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
        // Refresh User
        await fetchUser();
    } catch (e) { showToast("Error"); }
}

// Utils
function updateCredits(amount) {
    if (currentUser) currentUser.credits = amount;
    const el = document.getElementById('credit-count');
    if (el) el.textContent = amount;
}

function showToast(msg) {
    const d = document.getElementById('toast-container');
    if (d) {
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        d.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    } else {
        console.log(msg);
    }
}

// --- DESIGN SYSTEM "100x" LOGIC ---

// 1. Tilt Effect for Cards
function initTiltEffect() {
    const cards = document.querySelectorAll('.lib-item, .price-card');
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            const rotateX = ((y - centerY) / centerY) * -5; // Max 5 deg
            const rotateY = ((x - centerX) / centerX) * 5;

            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.02)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) scale(1)';
        });
    });
}

// 2. Advanced Particle System
function initAdvancedParticles() {
    const cvs = document.getElementById('hero-canvas');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    let w, h;
    const particles = [];

    function resize() {
        w = cvs.width = window.innerWidth;
        h = cvs.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    class Particle {
        constructor() {
            this.x = Math.random() * w;
            this.y = Math.random() * h;
            this.vx = (Math.random() - 0.5) * 0.5;
            this.vy = (Math.random() - 0.5) * 0.5;
            this.size = Math.random() * 2 + 1;
            this.alpha = Math.random() * 0.5 + 0.1;
        }
        update() {
            this.x += this.vx;
            this.y += this.vy;
            if (this.x < 0) this.x = w;
            if (this.x > w) this.x = 0;
            if (this.y < 0) this.y = h;
            if (this.y > h) this.y = 0;
        }
        draw() {
            ctx.fillStyle = currentTheme === 'light' ? `rgba(0,0,0,${this.alpha})` : `rgba(255,255,255,${this.alpha})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    for (let i = 0; i < 50; i++) particles.push(new Particle());

    function loop() {
        ctx.clearRect(0, 0, w, h);

        // Connect nearby particles
        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw();
            for (let j = i; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 100) {
                    ctx.strokeStyle = currentTheme === 'light' ? `rgba(0,0,0,${0.1 - dist / 1000})` : `rgba(255,255,255,${0.1 - dist / 1000})`;
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }
        requestAnimationFrame(loop);
    }
    loop();
}

// Override Load Library to use Thumbnails
async function loadLibrary() {
    const box = document.getElementById('library-list');
    if (!box) return;
    box.style.display = 'grid';
    box.style.border = 'none';
    box.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:var(--text-sec); padding: 40px;">Syncing Library...</p>';

    setTimeout(async () => {
        try {
            await fetch(`${API_BASE}/sync`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });

            const t = new Date().getTime();
            const res = await fetch(`${API_BASE}/history?t=${t}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (res.status === 401) { logout(); return; }

            const data = await res.json();
            const projectCount = data.projects ? data.projects.length : 0;

            box.innerHTML = '';

            if (projectCount === 0) {
                box.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; border: 2px dashed var(--border); border-radius: 20px;">
                <i class="fa-solid fa-cloud-upload" style="font-size: 2rem; margin-bottom: 20px; color: var(--text-sec)"></i>
                <p>No projects found.</p>
                <button onclick="createTestProject()" style="margin-top:20px; background:var(--bg-surface); border:1px solid var(--border); padding:8px 16px; border-radius:8px; cursor:pointer;">
                    <i class="fa-solid fa-bug"></i> Generate Test Project
                </button>
            </div>`;
                return;
            }

            data.projects.forEach(p => {
                let dateStr = "Unknown Date";
                try {
                    const safeDate = p.date.replace(" ", "T");
                    dateStr = new Date(safeDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                } catch (e) { }

                const stemsCount = p.stems ? Object.keys(p.stems).length : 0;
                const isValid = stemsCount > 0;

                const div = document.createElement('div');
                div.className = 'lib-item library-card'; // Add library-card for styles
                if (!isValid) div.style.opacity = '0.6';

                // Thumbnail vs Icon
                let coverHtml = `<i class="fa-solid fa-record-vinyl"></i>`;
                let coverStyle = '';
                if (p.thumbnail) {
                    coverHtml = '';
                    coverStyle = `background-image: url('${p.thumbnail}'); background-size: cover; background-position: center;`;
                }

                div.innerHTML = `
                <div class="lib-cover" style="${coverStyle}">
                    ${coverHtml}
                </div>
                <div class="delete-btn" title="Delete Project" onclick="deleteProject(event, '${p.id}')">
                    <i class="fa-solid fa-trash"></i>
                </div>
                <div class="lib-meta">
                    <div class="lib-title">${p.name}</div>
                    <span class="lib-date">${dateStr}</span>
                    <div class="lib-tags">
                        <span class="tag">${stemsCount} STEMS</span>
                        <span class="tag">${isValid ? 'READY' : 'ERROR'}</span>
                    </div>
                </div>
             `;
                div.onclick = (e) => {
                    if (!e.target.closest('.delete-btn') && isValid) {
                        navTo('workspace'); loadMixer(p.name, p.stems);
                    }
                };
                box.appendChild(div);
            });

            // Apply Tilt
            setTimeout(initTiltEffect, 500);
            // --- 100x Features ---

            // --- Global Settings Functions ---

            // --- Global Settings Functions ---

            // 3. Update Profile Logic (Global)
            async function updateProfile() {
                const email = document.getElementById('set-email').value;
                const oldPass = document.getElementById('set-old-pass').value;
                const newPass = document.getElementById('set-new-pass').value;
                const btn = document.querySelector('.btn-outline.small'); // The edit button

                if (!email && !newPass) return showToast("Nothing to update");
                if (newPass && !oldPass) return showToast("Enter current password to change it");

                btn.disabled = true;
                btn.textContent = "Saving...";

                try {
                    const payload = {};
                    if (email !== state.user.email) payload.email = email;
                    if (newPass) {
                        payload.password = oldPass;
                        payload.new_password = newPass;
                    }

                    const res = await fetch('/api/me', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${state.token}`
                        },
                        body: JSON.stringify(payload)
                    });

                    if (res.ok) {
                        showToast("Profile Updated Successfully");
                        // Update local state
                        if (payload.email) state.user.email = payload.email;
                        // Clear passwords
                        document.getElementById('set-old-pass').value = '';
                        document.getElementById('set-new-pass').value = '';
                    } else {
                        const err = await res.json();
                        showToast(err.detail || "Update Failed");
                    }
                } catch (e) {
                    console.error(e);
                    showToast("Connection Error");
                } finally {
                    btn.disabled = false;
                    btn.textContent = "Save Changes";
                }
            }
        } catch (e) {
            console.error(e);
            box.innerHTML = '<p style="text-align:center; color:red">Error loading library.</p>';
        }
    }, 100);
}

// --- 4. Comparison Slider Logic ---
function initComparisonSlider() {
    const container = document.getElementById('compare-widget');
    if (!container) return;

    const handle = container.querySelector('.compare-handle');
    const before = container.querySelector('.compare-before');
    let isDown = false;

    function move(x) {
        const rect = container.getBoundingClientRect();
        let pos = ((x - rect.left) / rect.width) * 100;
        pos = Math.max(0, Math.min(100, pos));

        handle.style.left = `${pos}%`;
        before.style.clipPath = `polygon(0 0, ${pos}% 0, ${pos}% 100%, 0 100%)`;
    }

    // Mouse
    container.addEventListener('mousedown', () => isDown = true);
    window.addEventListener('mouseup', () => isDown = false);
    window.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        move(e.clientX);
    });

    // Touch
    container.addEventListener('touchstart', () => isDown = true);
    window.addEventListener('touchend', () => isDown = false);
    container.addEventListener('touchmove', (e) => {
        if (!isDown) return;
        move(e.touches[0].clientX);
    });

    // Init Center
    move(container.getBoundingClientRect().left + (container.offsetWidth / 2));
}

// --- 5. Scroll Animations (Intersection Observer) ---
function initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, { threshold: 0.1 });

    const targets = document.querySelectorAll('.fade-in, .bento-card, .section-head, .p-card, .faq-item');
    targets.forEach(t => observer.observe(t));
}

// --- 6. Hero Motion Graphics (Canvas) ---
function initHeroAnimation() {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let width, height;
    let particles = [];

    function resize() {
        width = canvas.width = canvas.offsetWidth;
        height = canvas.height = canvas.offsetHeight;
        initParticles();
    }

    function initParticles() {
        particles = [];
        const cnt = width < 600 ? 30 : 60; // Responsive count
        for (let i = 0; i < cnt; i++) {
            particles.push({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.5,
                vy: (Math.random() - 0.5) * 0.5,
                size: Math.random() * 2 + 1,
                alpha: Math.random() * 0.5 + 0.1
            });
        }
    }

    function draw() {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');

        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;

            if (p.x < 0) p.x = width;
            if (p.x > width) p.x = 0;
            if (p.y < 0) p.y = height;
            if (p.y > height) p.y = 0;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.globalAlpha = p.alpha;
            ctx.fill();
        });

        // Connections
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
        particles.forEach((p1, i) => {
            particles.slice(i + 1).forEach(p2 => {
                const dx = p1.x - p2.x;
                const dy = p1.y - p2.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 150) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.globalAlpha = (1 - dist / 150) * 0.2;
                    ctx.stroke();
                }
            });
        });

        requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    draw();
}

// Hook into Init - REPLACING the old listener to ensure clean execution order
const originalInit = window.onload;
document.addEventListener('DOMContentLoaded', () => {
    // 1. Existing Particles (if any, redundant with Hero Anim but keeping safely)
    setTimeout(initAdvancedParticles, 1000);

    // 2. New Impressive Features
    initComparisonSlider();
    initScrollAnimations();
    initHeroAnimation();

    // 3. Mobile Menu Toggle
    const menuBtn = document.getElementById('menu-btn');
    const mobileMenu = document.querySelector('.mobile-menu');
    if (menuBtn && mobileMenu) {
        menuBtn.onclick = () => {
            mobileMenu.classList.toggle('open');
            menuBtn.innerHTML = mobileMenu.classList.contains('open') ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
        };
    }
});
