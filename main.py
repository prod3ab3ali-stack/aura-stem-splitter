import os
import shutil
import sqlite3
import subprocess
import uuid
import datetime
import math
import wave
from pathlib import Path
from typing import Optional, List
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends, Header, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import shutil
import yt_dlp
import sys

# --- Constants & Config ---
BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
DB_PATH = BASE_DIR / "data.db"

INPUT_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Database Setup ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    # OPTIMIZATION for "Thousands of Users": Write-Ahead Logging
    conn.execute("PRAGMA journal_mode=WAL;") 
    conn.execute("PRAGMA synchronous=NORMAL;")
    
    c = conn.cursor()
    
    # Users Table (Updated with Email)
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        is_admin INTEGER DEFAULT 0,
        credits INTEGER DEFAULT 10,
        plan TEXT DEFAULT 'free',
        created_at TEXT,
        email TEXT
    )''')
    
    # Migration: Add email column if it doesn't exist (for existing DBs)
    try:
        c.execute("ALTER TABLE users ADD COLUMN email TEXT")
    except:
        pass # Column likely exists
    
    # Sessions Table
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT,
        created_at TEXT
    )''')
    
    # Projects Table (Link files to users)
    c.execute('''CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT,
        folder_path TEXT,
        created_at TEXT
    )''')

    # Create default admin if not exists
    c.execute("SELECT * FROM users WHERE username = 'admin'")
    if not c.fetchone():
        admin_id = str(uuid.uuid4())
        c.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  (admin_id, 'admin', 'admin123', 1, 9999, 'unlimited', str(datetime.datetime.now()), 'admin@aura.com'))
    
    conn.commit()
    conn.close()

init_db()

# --- Models ---
class UserAuth(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    new_password: Optional[str] = None

class UserResponse(BaseModel):
    id: str
    username: str
    is_admin: bool
    credits: int
    plan: str
    email: Optional[str]

# --- Dependencies ---
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Token")
    
    token = authorization.replace("Bearer ", "")
    
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT user_id FROM sessions WHERE token = ?", (token,))
    row = c.fetchone()
    
    if not row:
        conn.close()
        raise HTTPException(status_code=401, detail="Invalid Token")
    
    user_id = row[0]
    c.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user_row = c.fetchone()
    conn.close()
    
    if not user_row:
        raise HTTPException(status_code=401, detail="User not found")
        
    # User Row Map: 0:id, 1:username, 2:password, 3:admin, 4:credits, 5:plan, 6:created, 7:email
    return {
        "id": user_row[0], "username": user_row[1], "password": user_row[2],
        "is_admin": bool(user_row[3]), "credits": user_row[4], "plan": user_row[5],
        "created_at": user_row[6], "email": user_row[7] if len(user_row) > 7 else ""
    }

# --- Auth Routes ---
@app.post("/api/signup")
def signup(auth: UserAuth):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    try:
        user_id = str(uuid.uuid4())
        email = auth.email if auth.email else ""
        # Give 3 free credits
        c.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  (user_id, auth.username, auth.password, 0, 3, 'free', str(datetime.datetime.now()), email))
        conn.commit()
        return {"message": "User created", "username": auth.username}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.post("/api/login")
def login(auth: UserAuth):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username = ? AND password = ?", (auth.username, auth.password))
    row = c.fetchone()
    
    if not row:
        conn.close()
        raise HTTPException(status_code=400, detail="Invalid credentials")
    
    user_id = row[0]
    token = str(uuid.uuid4())
    c.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user_id, str(datetime.datetime.now())))
    conn.commit()
    conn.close()
    
    return {
        "token": token,
        "user": {
            "id": user_id,
            "username": row[1],
            "is_admin": bool(row[3]),
            "credits": row[4],
            "plan": row[5],
            "email": row[7] if len(row) > 7 else ""
        }
    }

@app.get("/api/me")
def get_me(user: dict = Depends(get_current_user)):
    user_safe = user.copy()
    user_safe.pop("password")
    return user_safe

@app.put("/api/me")
def update_me(update: UserUpdate, user: dict = Depends(get_current_user)):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    if update.email:
        c.execute("UPDATE users SET email = ? WHERE id = ?", (update.email, user['id']))
    
    if update.password and update.new_password:
        if update.password != user['password']:
             conn.close()
             raise HTTPException(status_code=400, detail="Current password incorrect")
        c.execute("UPDATE users SET password = ? WHERE id = ?", (update.new_password, user['id']))

    conn.commit()
    conn.close()
    return {"message": "Profile updated"}

@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization:
        token = authorization.replace("Bearer ", "")
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    return {"message": "Logged out"}

# --- Process Routes ---
import yt_dlp

# --- GLOBAL SSL & DNS PATCH (The "Nuclear" Solution) ---
# --- GLOBAL SSL & DNS PATCH (The "Nuclear" Solution) ---
import os
import ssl
import certifi
import requests.api
import requests.sessions

# 1. SSL Fix: Force certifi path (Fallback)
os.environ['SSL_CERT_FILE'] = certifi.where()
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()

# 2. MONKEY PATCH REQUESTS TO DISABLE VERIFICATION
# This ensures that even if a library asks for verification, we say NO.
# Needed because our DNS patch forces IP connections which fail hostname checks.
original_request = requests.sessions.Session.request

def patched_request(self, *args, **kwargs):
    kwargs['verify'] = False # FORCE DISABLE SSL VERIFY
    return original_request(self, *args, **kwargs)

requests.sessions.Session.request = patched_request
# REMOVED: requests.api.request patch (not needed and caused signature mismatch)

# 3. Patch SSL Context default (Double Tap)
ssl._create_default_https_context = ssl._create_unverified_context

# 4. DNS Fix: Replace broken container resolver with dnspython
try:
    import dns.resolver
    # ... (Rest of DNS Logic) ...
    import socket

    # Configure Google DNS
    my_resolver = dns.resolver.Resolver()
    my_resolver.nameservers = ['8.8.8.8', '8.8.4.4', '1.1.1.1']

    _orig_getaddrinfo = socket.getaddrinfo

    def patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        # 1. Try standard first (mostly for localhost/IPs)
        try:
             # If it's an IP, this returns immediately
             return _orig_getaddrinfo(host, port, family, type, proto, flags)
        except:
             pass
        
        # 2. Manual Resolve via 8.8.8.8
        try:
            # print(f"DEBUG: Manual DNS Resolve for {host}")
            answers = my_resolver.resolve(host, 'A')
            ip = answers[0].to_text()
            # print(f"DEBUG: Resolved {host} -> {ip}")
            return _orig_getaddrinfo(ip, port, family, type, proto, flags)
        except Exception as e:
            # print(f"DEBUG: DNS Fail {host}: {e}")
            raise socket.gaierror(f"DNS Resolution Failed for {host}")
            
    socket.getaddrinfo = patched_getaddrinfo
    
except ImportError:
    print("WARNING: dnspython not installed. DNS Patch skipped.")

# -----------------------------------

# (Rest of imports...)


# --- Core Logic Refactored ---
def core_process_track(input_path: Path, original_name: str, user: dict):
    # 1. Run Demucs (High Quality V4.1)
    import static_ffmpeg
    static_ffmpeg.add_paths()
    ffmpeg_path = shutil.which("ffmpeg")
    current_env = os.environ.copy()

    # OPTIMIZATION: Limit threads to avoid freezing the CPU
    current_env["OMP_NUM_THREADS"] = "1"
    current_env["MKL_NUM_THREADS"] = "1"

    cmd = [
        sys.executable,
        "-m", "demucs.separate",
        "-n", "htdemucs", # Lighter model than htdemucs_6s
        "--shifts", "0",  # Fastest
        "--overlap", "0.1", # Minimum overlap
        "--float32",
        "-o", str(OUTPUT_DIR),
        "-j", "1", # Single job
        str(input_path)
    ]
    
    p = subprocess.run(cmd, capture_output=True, text=True, env=current_env)
    
    if p.returncode != 0:
        print(f"CORE DEMUCS STDERR: {p.stderr}")
        raise HTTPException(status_code=500, detail="Core Processing Failed")

    # 2. Verify Output
    internal_id = input_path.stem
    base_out = OUTPUT_DIR / "htdemucs" # Checking correct folder
    created_folder = base_out / internal_id
    
    if not created_folder.exists():
        print(f"CRITICAL: Expected output {created_folder} missing.")
        raise HTTPException(status_code=500, detail="Processing Output Missing")

    # 3. Audio Polish & Smart Analysis (V5.0)
    final_stems = {}
    
    # Path to ffmpeg
    ffmpeg_exe = str(ffmpeg_path) if ffmpeg_path else "ffmpeg"

    for f in created_folder.glob("*.wav"):
        try:
            # A. Smart Polish: Simple Normalize
            polished_path = f.with_suffix(".polished.wav")
            
            filter_chain = "norm=0" 
            if "bass" not in f.name and "drums" not in f.name:
                filter_chain += ",highpass=f=50"
            
            cmd_polish = [
                ffmpeg_exe, "-y",
                "-i", str(f),
                "-af", filter_chain,
                "-ar", "44100", 
                str(polished_path)
            ]
            
            subprocess.run(cmd_polish, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Clean replace logic
            if polished_path.exists() and polished_path.stat().st_size > 1000: # Ensure not empty
                f.unlink() # Delete original
                polished_path.rename(f) # Move polished to original name
            elif polished_path.exists():
                polished_path.unlink() # Delete failed/empty polished file
            
            # B. Silence Detection
            is_silent = True
            with wave.open(str(f), 'rb') as wav_file:
                if wav_file.getnframes() > 0:
                    frames_to_read = min(wav_file.getnframes(), 48000 * 30) 
                    data = wav_file.readframes(frames_to_read)
                    import numpy as np
                    samples = np.frombuffer(data, dtype=np.int16)
                    max_amp = np.max(np.abs(samples)) if len(samples) > 0 else 0
                    if max_amp > 150: is_silent = False
            
            if is_silent:
                 f.unlink()
            else:
                 final_stems[f.stem] = f"/stems/htdemucs/{created_folder.name}/{f.name}"
        except Exception as e:
            print(f"Error analyzing/polishing {f}: {e}")
            final_stems[f.stem] = f"/stems/htdemucs/{created_folder.name}/{f.name}"

    # 4. Save to DB
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET credits = credits - 1 WHERE id = ?", (user["id"],))
    
    safe_human_name = Path(original_name).stem
    conn.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?)",
                 (internal_id, user["id"], safe_human_name, internal_id, str(datetime.datetime.now())))
    conn.commit()
    conn.close()

    return {
        "message": "Success",
        "credits_left": user["credits"] - 1,
        "stems": final_stems,
        "project": {"id": internal_id, "name": safe_human_name}
    }

@app.on_event("startup")
async def startup_event():
    print("MATCHBOX AUDIO ENGINE V4.2 - DNS PATCHED")
    # Initialize DB (already done globally but good for hooks)
    pass

@app.post("/api/process")
async def process_audio(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user)
):
    if user["credits"] < 1:
        raise HTTPException(status_code=402, detail="Insufficient credits")

    file_ext = Path(file.filename).suffix or ".wav"
    internal_id = str(uuid.uuid4())
    temp_filename = f"{internal_id}{file_ext}"
    input_path = INPUT_DIR / temp_filename
    
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    # Create a wrapper to run the sync processing in a thread
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(core_process_track, input_path, file.filename, user)

from fastapi import BackgroundTasks
import threading

# --- In-Memory Job Store ---
JOBS = {}

def update_job(jid, status, progress=0):
    if jid in JOBS:
        JOBS[jid]["status"] = status
        JOBS[jid]["progress"] = progress

# SHARED PIPELINE: Runs inside a background thread
def run_separation_pipeline(job_id: str, input_path: Path, meta_title: str, user: dict):
    try:
        update_job(job_id, "Initializing Neural Engine...", 10)
        
        # 1. Run Demucs (Optimized for Speed)
        import static_ffmpeg
        static_ffmpeg.add_paths()
        current_env = os.environ.copy()
        
        # OPTIMIZATION: Limit threads to avoid freezing the CPU
        current_env["OMP_NUM_THREADS"] = "1"
        current_env["MKL_NUM_THREADS"] = "1"
        
        # PERFORMANCE FIX: "shifts=0" is fastest. 
        # Using "htdemucs" (Hybrid Transformer) - standard version.
        # USE RAM/CPU BALANCING: 'nice -n 15' lowers priority so Web UI doesn't freeze.
        cmd = [
            "nice", "-n", "15",
            sys.executable, "-m", "demucs.separate",
            "-n", "htdemucs",  # Lighter model
            "--shifts", "0",   # FASTEST MODE
            "--overlap", "0.1",# MINIMUM OVERLAP
            "--float32",
            "-o", str(OUTPUT_DIR),
            "-j", "1",         # Force single thread
            str(input_path)
        ]
        
        update_job(job_id, "Separating Stems (Fast Mode)...", 20)
        
        # Deadlock Prevention: Don't use capture_output=True for long running processes
        # Redirect to DEVNULL for safety, or a temp file if debugging needed.
        # We rely on exit code.
        p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=current_env)
        
        if p.returncode != 0:
            print(f"DEMUCS STDERR: {p.stderr}") # PRINT FULL ERROR TO LOGS
            raise Exception(f"Demucs Failed (Code {p.returncode})")
            
        update_job(job_id, "Polishing Audio (Normalization)...", 80)
        
        # 2. Verify Output
        internal_id = input_path.stem
        # Note: Model name change affects folder structure
        base_out = OUTPUT_DIR / "htdemucs" 
        created_folder = base_out / internal_id
        
        # Retry logic
        if not created_folder.exists():
             import time
             time.sleep(1)
             
        if not created_folder.exists():
             # List output dir to debug where it went
             print(f"DEBUG: Contents of {OUTPUT_DIR}: {list(OUTPUT_DIR.glob('*'))}")
             raise Exception(f"Output folder not found: {created_folder}")

        # 3. Smart Analysis & DB
        final_stems = {}
        
        for f in created_folder.glob("*.wav"):
            try:
                # B. Silence Detection Only (No FFmpeg Polish)
                is_silent = True
                with wave.open(str(f), 'rb') as wav_file:
                    if wav_file.getnframes() > 0:
                        frames_to_read = min(wav_file.getnframes(), 48000 * 30) 
                        data = wav_file.readframes(frames_to_read)
                        import numpy as np
                        samples = np.frombuffer(data, dtype=np.int16)
                        max_amp = np.max(np.abs(samples)) if len(samples) > 0 else 0
                        if max_amp > 150: is_silent = False
                
                if is_silent:
                     f.unlink()
                else:
                     final_stems[f.stem] = f"/stems/htdemucs/{created_folder.name}/{f.name}"
            except:
                final_stems[f.stem] = f"/stems/htdemucs/{created_folder.name}/{f.name}"

        # 4. Save DB
        conn = sqlite3.connect(DB_PATH)
        conn.execute("UPDATE users SET credits = credits - 1 WHERE id = ?", (user["id"],))
        safe_human_name = Path(meta_title).stem
        current_time = str(datetime.datetime.now())
        conn.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?)",
                     (internal_id, user["id"], safe_human_name, internal_id, current_time))
        conn.commit()
        conn.close()

        result = {
            "message": "Success",
            "credits_left": user["credits"] - 1,
            "stems": final_stems,
            "project": {"id": internal_id, "name": safe_human_name}
        }
        
        JOBS[job_id]["result"] = result
        JOBS[job_id]["status"] = "completed"
        JOBS[job_id]["progress"] = 100
        
    except Exception as e:
        print(f"Pipeline Error: {e}")
        JOBS[job_id]["error"] = str(e)
        JOBS[job_id]["status"] = "failed"

# --- ASYNC ROUTES ---

@app.post("/api/process_file_async")
async def process_file_async(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user)
):
    if user["credits"] < 1: raise HTTPException(status_code=402, detail="Insufficient credits")
    
    # Save Upload
    file_ext = Path(file.filename).suffix or ".wav"
    internal_id = str(uuid.uuid4())
    input_path = INPUT_DIR / f"{internal_id}{file_ext}"
    
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    # Start Job
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {"status": "queued", "progress": 0, "result": None, "start_time": datetime.datetime.now().timestamp()}
    
    background_tasks.add_task(run_separation_pipeline, job_id, input_path, file.filename, user)
    return {"job_id": job_id}

@app.get("/api/download_zip/{project_id}")
def download_zip(project_id: str):
    # Security: Ensure project exists
    project_path = OUTPUT_DIR / "htdemucs" / project_id
    if not project_path.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    # Create ZIP in memory
    import io
    import zipfile
    
    zip_buffer = io.BytesIO()
    # OPTIMIZATION: Use ZIP_STORED. WAV files do not compress well. 
    # Attempting to compress them burns CPU and delays the download for 0% gain.
    # ZIP_STORED is effectively a "copy", making it instant.
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zip_file:
        for file in project_path.glob("*"):
            if file.is_file() and file.suffix != '.zip':
                zip_file.write(file, arcname=file.name)
    
    zip_buffer.seek(0)
    
    return StreamingResponse(
        zip_buffer, 
        media_type="application/zip", 
        headers={"Content-Disposition": f"attachment; filename=stems_{project_id}.zip"}
    )

@app.post("/api/process_youtube_async")
def start_youtube_job(
    background_tasks: BackgroundTasks, 
    url: str = Form(...), 
    user: dict = Depends(get_current_user)
):
    if user["credits"] < 1:
        raise HTTPException(status_code=402, detail="Insufficient credits")
        
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {"status": "queued", "progress": 0, "result": None, "start_time": datetime.datetime.now().timestamp()}
    
    # Determine the pipeline
    def youtube_wrapper(jid, u, usr):
        try:
            update_job(jid, "Connecting to YouTube...", 5)
            internal_id = str(uuid.uuid4())
            input_path = INPUT_DIR / f"{internal_id}"
            
            # Progress Hook
            def ph(d):
                if d['status'] == 'downloading':
                    str_p = d.get('_percent_str', '0%').replace('%','')
                    try:
                        update_job(jid, f"Downloading: {str_p}%", 10 + float(str_p) * 0.2)
                    except: pass
                elif d['status'] == 'finished':
                    update_job(jid, "Formatting Audio...", 35)

            # --- YT-DLP Standard Logic (Restored) ---
            import static_ffmpeg
            static_ffmpeg.add_paths()
            ffmpeg_path = shutil.which("ffmpeg")
            
            ydl_opts = {
                'format': 'bestaudio/best',
                'ffmpeg_location': str(ffmpeg_path),
                'outtmpl': str(input_path), # yt-dlp will add extension
                'writethumbnail': True, 
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'wav', 'preferredquality': '192'}],
                'nocheckcertificate': True,
                'ignoreerrors': True,
                'no_warnings': False,
                'quiet': False, 
                'verbose': True,
                'socket_timeout': 15,
                'retries': 10,
                'force_ipv4': True,
                'extractor_args': {'youtube': {'player_client': ['android', 'web']}},
                'progress_hooks': [ph]
            }
            
            meta_title = "Youtube Download"
            thumb_url = None
            
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(u, download=True)
                    meta_title = info.get('title', meta_title)
                    thumb_url = info.get('thumbnail', None)
            except Exception as e:
                print(f"YT-DLP FINAL ERROR: {e}")
                raise e
                
            # Find the actual downloaded audio file (yt-dlp adds extension)
            downloaded_audio_path = None
            for f in INPUT_DIR.glob(f"{internal_id}.*"):
                if f.suffix in ['.wav', '.mp3', '.m4a', '.ogg', '.flac']: # Common audio extensions
                    downloaded_audio_path = f
                    break
            
            if not downloaded_audio_path:
                raise Exception("YT-DLP download failed to produce an audio file.")
            
            # Hand over to main pipeline, passing thumbnail if possible?
            # We can modify core pipeline later, for now let's just process.
            # To stick thumbnail to project, we need to move it to output dir later?
            # Main pipeline handles separation.
            
            run_separation_pipeline(jid, final_path, meta_title, usr)
            
            # Post-Process: Copy Thumbnail if exists (yt-dlp usually names it same as input)
            # Input was input_path (no extension). Thumbnail is likely input_path.jpg or .webp
            # We need to find it and move it to the OUTPUT project folder.
            base_out = OUTPUT_DIR / "htdemucs" / final_path.stem
            
            # Find any image starting with internal_id in INPUT_DIR
            for img in INPUT_DIR.glob(f"{internal_id}.*"):
                if img.suffix in ['.jpg', '.jpeg', '.png', '.webp']:
                    if base_out.exists():
                        shutil.copy(img, base_out / "thumbnail.jpg")

        except Exception as e:
            JOBS[jid]["error"] = str(e)
            JOBS[jid]["status"] = "failed"
            
    background_tasks.add_task(youtube_wrapper, job_id, url, user)
    return {"job_id": job_id}

@app.get("/api/jobs/{job_id}")
def get_job_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JOBS[job_id]

@app.get("/api/history")
def get_history(user: dict = Depends(get_current_user)):
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # Get user projects
    c.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC", (user["id"],))
    rows = c.fetchall()
    
    projects = []
    for r in rows:
        folder_name = r["folder_path"]
        folder_path = OUTPUT_DIR / "htdemucs" / folder_name
        
        stems = {}
        thumbnail_url = None
        
        if folder_path.exists():
            for f in folder_path.glob("*.wav"):
                stems[f.stem] = f"/stems/htdemucs/{folder_name}/{f.name}"
            if not stems:
                for f in folder_path.glob("*.mp3"):
                    stems[f.stem] = f"/stems/htdemucs/{folder_name}/{f.name}"
            
            # Find Thumbnail
            for img in folder_path.glob("thumbnail.*"): 
                if img.suffix in ['.jpg', '.jpeg', '.png', '.webp']:
                    thumbnail_url = f"/stems/htdemucs/{folder_name}/{img.name}"
                    break
        
        projects.append({
            "id": r["id"],
            "name": r["name"],
            "date": r["created_at"],
            "stems": stems,
            "thumbnail": thumbnail_url
        })
    conn.close()
    return {"projects": projects}

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, user: dict = Depends(get_current_user)):
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    c = conn.cursor()
    
    c.execute("SELECT folder_path, user_id FROM projects WHERE id = ?", (project_id,))
    row = c.fetchone()
    
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Project not found")
        
    if row[1] != user["id"] and not user["is_admin"]:
        conn.close()
        raise HTTPException(status_code=403, detail="Not authorized")
        
    folder_name = row[0]
    folder_path = OUTPUT_DIR / "htdemucs" / folder_name
    
    c.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()
    conn.close()
    
    if folder_path.exists() and folder_path.is_dir():
        shutil.rmtree(folder_path)

    # Cleanup Input Files
    # The project ID corresponds to the input file stem (internal_id)
    # We look for any file in INPUT_DIR with that name (ignoring extension)
    for f in INPUT_DIR.glob(f"{folder_name}.*"):
        try:
            f.unlink()
        except:
            pass

    return {"message": "Deleted"}

@app.post("/api/sync")
def sync_legacy_projects(user: dict = Depends(get_current_user)):
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    c = conn.cursor()
    
    base_out = OUTPUT_DIR / "htdemucs_6s"
    if not base_out.exists():
        conn.close()
        return {"added": 0}
        
    existing_folders = set()
    rows = c.execute("SELECT folder_path FROM projects").fetchall()
    for r in rows:
        existing_folders.add(r[0])
        
    added_count = 0
    for folder in base_out.iterdir():
        if folder.is_dir():
            if folder.name not in existing_folders:
                pid = str(uuid.uuid4())
                c.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?)",
                          (pid, user["id"], folder.name, folder.name, str(datetime.datetime.now())))
                added_count += 1
                
    return {"added": added_count}

@app.post("/api/debug/test_project")
def create_test_project(user: dict = Depends(get_current_user)):
    conn = sqlite3.connect(DB_PATH)
    project_id = str(uuid.uuid4())
    folder_name = project_id 
    folder_path = OUTPUT_DIR / "htdemucs_6s" / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)
    
    for stem in ["vocals", "drums", "bass", "other"]:
        (folder_path / f"{stem}.wav").touch()
    
    # Create Dummy Thumbnail
    with open(folder_path / "thumbnail.jpg", "wb") as f:
        pass # Empty file just for existence check
        
    conn.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?)",
                 (project_id, user["id"], "Debug Project " + project_id[:4], folder_name, str(datetime.datetime.now())))
    conn.commit()
    conn.close()
    return {"message": "Test project created", "id": project_id}

# --- Subscription / Admin ---
@app.post("/api/subscribe")
def subscribe(plan: str, user: dict = Depends(get_current_user)):
    # Mock payment processing
    credits_map = {'free': 10, 'pro': 100, 'studio': 99999}
    credits_to_set = credits_map.get(plan, 10)
    
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET credits = ?, plan = ? WHERE id = ?", (credits_to_set, plan, user["id"]))
    conn.commit()
    conn.close()
    return {"message": f"Subscribed to {plan}", "credits_left": credits_to_set}

@app.get("/api/admin/users")
def admin_users(user: dict = Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT id, username, credits, plan, created_at FROM users")
    users = [dict(row) for row in c.fetchall()]
    conn.close()
    return {"users": users}

# --- Static Mounts ---
app.mount("/stems", StaticFiles(directory=OUTPUT_DIR), name="stems")
app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
