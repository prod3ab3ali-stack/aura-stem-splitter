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

# --- Core Logic Refactored ---
def core_process_track(input_path: Path, original_name: str, user: dict):
    # 1. Run Demucs (High Quality V4.1)
    import static_ffmpeg
    static_ffmpeg.add_paths()
    current_env = os.environ.copy()

    cmd = [
        sys.executable,
        "-m", "demucs.separate",
        "-n", "htdemucs_6s",
        "--shifts", "4",
        "--overlap", "0.5",
        "--float32",
        "-o", str(OUTPUT_DIR),
        str(input_path)
    ]
    
    p = subprocess.run(cmd, capture_output=True, text=True, env=current_env)
    
    if p.returncode != 0:
        print(p.stderr)
        raise HTTPException(status_code=500, detail="Core Processing Failed")

    # 2. Verify Output
    internal_id = input_path.stem
    base_out = OUTPUT_DIR / "htdemucs_6s"
    created_folder = base_out / internal_id
    
    if not created_folder.exists():
        print(f"CRITICAL: Expected output {created_folder} missing.")
        raise HTTPException(status_code=500, detail="Processing Output Missing")

    # 3. Audio Polish & Smart Analysis (V5.0)
    # We will iterate files, CLEAN them, and remove silent ones.
    final_stems = {}
    
    # Path to ffmpeg (reused from above)
    ffmpeg_exe = str(ffmpeg_path / "ffmpeg") if ffmpeg_path.exists() else "ffmpeg"

    for f in created_folder.glob("*.wav"):
        try:
            # A. Smart Polish: Normalize & Clean
            # Create a localized temp file for processing
            polished_path = f.with_suffix(".polished.wav")
            
            # Audio Filters:
            # 1. silenceremove: removes absolute silence from start
            # 2. loudnorm: standardizes perceived loudness (optional, maybe too aggressive? let's simple peak normalize)
            # Let's use simple peak normalization to -1dB to avoid clipping but maximize volume.
            # Also apply a slight high-pass to non-bass elements to clean mud.
            
            filter_chain = "norm=0" # Default: maximize volume
            
            if "bass" not in f.name and "drums" not in f.name:
                # Cut very low mud from vocals/other
                filter_chain += ",highpass=f=50"
            
            cmd_polish = [
                ffmpeg_exe, "-y",
                "-i", str(f),
                "-af", filter_chain,
                "-ar", "44100", # Standardization
                str(polished_path)
            ]
            
            # Run Polish
            subprocess.run(cmd_polish, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Replace original with polished if successful
            if polished_path.exists() and polished_path.stat().st_size > 0:
                f.unlink()
                polished_path.rename(f)
            
            # B. Silence Detection (Previous Logic)
            is_silent = True
            with wave.open(str(f), 'rb') as wav_file:
                if wav_file.getnframes() > 0:
                    frames_to_read = min(wav_file.getnframes(), 48000 * 30) 
                    data = wav_file.readframes(frames_to_read)
                    import numpy as np
                    samples = np.frombuffer(data, dtype=np.int16)
                    max_amp = np.max(np.abs(samples)) if len(samples) > 0 else 0
                    if max_amp > 150:
                        is_silent = False
            
            if is_silent:
                 f.unlink()
            else:
                 final_stems[f.stem] = f"/stems/htdemucs_6s/{created_folder.name}/{f.name}"
        except Exception as e:
            print(f"Error analyzing/polishing {f}: {e}")
            # Fallback: keep it
            final_stems[f.stem] = f"/stems/htdemucs_6s/{created_folder.name}/{f.name}"

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
        
    return core_process_track(input_path, file.filename, user)

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
        
        # PERFORMANCE FIX: "shifts=1" is 4x faster than "shifts=4". 
        # Quality is still excellent with htdemucs_6s.
        cmd = [
            sys.executable, "-m", "demucs.separate",
            "-n", "htdemucs_6s",
            "--shifts", "1",  # SPEED OPTIMIZATION
            "--overlap", "0.25", # BALANCED
            "--float32",
            "-o", str(OUTPUT_DIR),
            str(input_path)
        ]
        
        update_job(job_id, "Separating Stems (Fast Mode)...", 20)
        
        # Deadlock Prevention: Don't use capture_output=True for long running processes
        # Redirect to DEVNULL for safety, or a temp file if debugging needed.
        # We rely on exit code.
        p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=current_env)
        
        if p.returncode != 0:
            raise Exception(f"Demucs Failed (Code {p.returncode}): {p.stderr[:200]}")
            
        update_job(job_id, "Polishing Audio (Normalization)...", 80)
        
        # 2. Verify Output
        internal_id = input_path.stem
        base_out = OUTPUT_DIR / "htdemucs_6s"
        created_folder = base_out / internal_id
        
        # Retry logic
        if not created_folder.exists():
             import time
             time.sleep(1)
             
        if not created_folder.exists():
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
                     final_stems[f.stem] = f"/stems/htdemucs_6s/{created_folder.name}/{f.name}"
            except:
                final_stems[f.stem] = f"/stems/htdemucs_6s/{created_folder.name}/{f.name}"

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
    project_path = OUTPUT_DIR / "htdemucs_6s" / project_id
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

            import static_ffmpeg
            static_ffmpeg.add_paths()
            ffmpeg_path = shutil.which("ffmpeg")
            
            # Add writethumbnail
            ydl_opts = {
                'format': 'bestaudio/best',
                'ffmpeg_location': str(ffmpeg_path),
                'outtmpl': str(input_path),
                'writethumbnail': True, # Get Thumbnail sidecar
                'postprocessors': [
                    {'key': 'FFmpegExtractAudio', 'preferredcodec': 'wav', 'preferredquality': '192'},
                    # Removed EmbedThumbnail due to container incompatibility with WAV
                ],
                'noplaylist': True, 'nocheckcertificate': True,
                'extractor_args': {'youtube': {'player_client': ['android', 'ios']}},
                'quiet': True, 'no_warnings': True, 'progress_hooks': [ph],
                'force_ipv4': True
            }
            
            meta_title = "Youtube Download"
            thumb_url = None
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(u, download=True)
                meta_title = info.get('title', meta_title)
                thumb_url = info.get('thumbnail', None)
            
            final_path = INPUT_DIR / f"{internal_id}.wav"
            if not final_path.exists(): raise Exception("Download failed")
            
            # Hand over to main pipeline, passing thumbnail if possible?
            # We can modify core pipeline later, for now let's just process.
            # To stick thumbnail to project, we need to move it to output dir later?
            # Main pipeline handles separation.
            
            run_separation_pipeline(jid, final_path, meta_title, usr)
            
            # Post-Process: Copy Thumbnail if exists (yt-dlp usually names it same as input)
            # Input was input_path (no extension). Thumbnail is likely input_path.jpg or .webp
            # We need to find it and move it to the OUTPUT project folder.
            base_out = OUTPUT_DIR / "htdemucs_6s" / final_path.stem
            
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
        folder_path = OUTPUT_DIR / "htdemucs_6s" / folder_name
        
        stems = {}
        thumbnail_url = None
        
        if folder_path.exists():
            for f in folder_path.glob("*.wav"):
                stems[f.stem] = f"/stems/htdemucs_6s/{folder_name}/{f.name}"
            if not stems:
                for f in folder_path.glob("*.mp3"):
                    stems[f.stem] = f"/stems/htdemucs_6s/{folder_name}/{f.name}"
            
            # Find Thumbnail
            for img in folder_path.glob("thumbnail.*"): 
                if img.suffix in ['.jpg', '.jpeg', '.png', '.webp']:
                    thumbnail_url = f"/stems/htdemucs_6s/{folder_name}/{img.name}"
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
    folder_path = OUTPUT_DIR / "htdemucs_6s" / folder_name
    
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
