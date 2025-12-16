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
import firebase_admin
from firebase_admin import credentials, firestore
import logging

# --- CONSTANTS (Early Init) ---
BASE_DIR = Path(__file__).resolve().parent

# --- DB ABSTRACTION ---
class DatabaseInterface:
    def get_user(self, user_id): pass
    def get_user_by_email(self, email): pass
    def create_user(self, user_id, username, password, email): pass
    def create_session(self, token, user_id): pass
    def get_session(self, token): pass
    # Add other methods as needed...
    
# --- CONFIG ---
SERVICE_KEY = BASE_DIR / "serviceAccountKey.json"
HAS_FIREBASE = SERVICE_KEY.exists()

db_client = None

if HAS_FIREBASE:
    print("BOOT: Found serviceAccountKey.json. Using FIRESTORE.")
    try:
        cred = credentials.Certificate(str(SERVICE_KEY))
        firebase_admin.initialize_app(cred)
        db_client = firestore.client()
    except Exception as e:
        print(f"BOOT ERROR: Failed to init Firestore: {e}")
        HAS_FIREBASE = False

# ... Only defined if HAS_FIREBASE is True
def firestore_get_user(user_id):
    if not db_client: return None
    try:
        doc = db_client.collection('users').document(user_id).get()
        if doc.exists:
            return doc.to_dict()
    except Exception as e:
        print(f"Firestore Read Error: {e}")
    return None

# Helpers for fallback
def get_user_compat(user_id):
    if HAS_FIREBASE:
        u = firestore_get_user(user_id)
        if u: return u
        # Fallback logic if needed? No, Firestore is master.
        return None
    else:
        # SQLite Legacy
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = c.fetchone()
        conn.close()
        if row:
             return {
                "id": row[0], "username": row[1], "password": row[2],
                "is_admin": bool(row[3]), "credits": row[4], "plan": row[5],
                "email": row[7] if len(row)>7 else ""
            }
        return None

def deduct_credit(user_id):
    if HAS_FIREBASE:
        try:
            ref = db_client.collection('users').document(user_id)
            ref.update({"credits": firestore.Increment(-1)})
            return
        except: pass # Fallback to SQLite just in case?

    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET credits = credits - 1 WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()

def set_subscription(user_id, plan, credits):
    if HAS_FIREBASE:
        try:
            ref = db_client.collection('users').document(user_id)
            ref.update({"plan": plan, "credits": credits})
            return
        except: pass

    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET credits = ?, plan = ? WHERE id = ?", (credits, plan, user_id))
    conn.commit()
    conn.close()




# --- YOUTUBE DOWNLOADER ---

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends, Header, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import shutil
import yt_dlp
import sys

# --- Constants & Config ---
# BASE_DIR defined at top
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
    
    # 1. Check Session in SQLite (Hybrid Approach: Sessions are local/ephemeral ok?)
    # ideally sessions should be in Firestore too.
    # But for now let's keep sessions in sqlite to avoid 1000s of reads on Firestore per request.
    # We only fetch USER DATA from Firestore.
    
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT user_id FROM sessions WHERE token = ?", (token,))
    row = c.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=401, detail="Invalid Token")
    
    user_id = row[0]
    
    # 2. Get User Data (Compat)
    user = get_user_compat(user_id)
    if not user:
         raise HTTPException(status_code=401, detail="User Not Found")
         
    return user

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

class FireAuth(BaseModel):
    uid: str
    email: str
    username: Optional[str] = "User"

@app.post("/api/auth/firebase")
def firebase_sync(auth: FireAuth):
    user_id = auth.uid # Use Firebase UID as the ID
    final_email = auth.email
    final_user = auth.username if auth.username else auth.email.split('@')[0]

    if HAS_FIREBASE:
        # FIRESTORE LOGIC with Fallback
        try:
            doc_ref = db_client.collection('users').document(user_id)
            doc = doc_ref.get()
            
            if not doc.exists:
                # Create User
                new_user = {
                    "id": user_id,
                    "username": final_user,
                    "email": final_email,
                    "credits": 3,
                    "plan": "free",
                    "is_admin": False,
                    "created_at": str(datetime.datetime.now())
                }
                doc_ref.set(new_user)
            else:
                pass
                
            # Create Session (Local)
            conn = sqlite3.connect(DB_PATH)
            token = str(uuid.uuid4())
            conn.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user_id, str(datetime.datetime.now())))
            conn.commit()
            conn.close()
            
            u = doc_ref.get().to_dict()
            return {"token": token, "user": u}

        except Exception as e:
            print(f"FIREBASE ERROR (Falling back to SQLite): {e}")
            # Fallthrough to SQLite logic below
            pass

    # SQLITE LEGACY LOGIC (Fallback)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE email = ?", (auth.email,))
    row = c.fetchone()
    
    if not row:
        # Create Shadow User
        c.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  (user_id, final_user, "firebase_managed", 0, 3, 'free', str(datetime.datetime.now()), auth.email))
        conn.commit()
    else:
        user_id = row[0]
    
    token = str(uuid.uuid4())
    c.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token, user_id, str(datetime.datetime.now())))
    conn.commit()
    
    c.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = c.fetchone()
    conn.close()
    
    return {
        "token": token,
        "user": {
            "id": user_id,
            "username": row[1],
            "is_admin": bool(row[3]),
            "credits": row[4],
            "plan": row[5],
            "email": row[7]
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
        
        update_job(job_id, "Initializing Engine...", 0)
        
        # STREAMING EXECUTION
        # buffer_size=1 (line buffered), universal_newlines=True (text mode)
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True,
            env=current_env,
            bufsize=1,
            universal_newlines=True
        )
        
        # Read stderr for progress (Demucs uses TQDM on stderr)
        import re
        
        # We need to read continuously. strict line reading might block on \r
        # But let's try reading line by line.
        while True:
            line = process.stderr.readline()
            if not line and process.poll() is not None:
                break
            
            if line:
                # print(f"DEMUCS RAW: {line.strip()}") # Debug
                
                # Regex for TQDM percentage: " 42%|"
                match = re.search(r"(\d+)%\|", line)
                if match:
                    p = int(match.group(1))
                    # Map 0-100 of separation to 20-90 of total job
                    # Separation is the bulk of work.
                    # 20 + (p * 0.7)
                    scaled = 20 + int(p * 0.7)
                    update_job(job_id, f"Separating Stems ({p}%)", scaled)
        
        if process.returncode != 0:
            err = process.stderr.read()
            print(f"DEMUCS FINAL STDERR: {err}")
            raise Exception(f"Demucs Failed (Code {process.returncode})")
            
        update_job(job_id, "Polishing Audio (Normalization)...", 95)
        
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
        deduct_credit(user["id"])
        conn = sqlite3.connect(DB_PATH)
        # conn.execute("UPDATE users SET credits = credits - 1 WHERE id = ?", (user["id"],)) # Handled by helper
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

# --- REMOTE FILE PROCESSING (FIREBASE) ---
class RemoteFileRequest(BaseModel):
    url: str
    filename: str

@app.post("/api/process_remote_file")
async def process_remote_file(
    req: RemoteFileRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user)
):
    if user["credits"] < 1: raise HTTPException(status_code=402, detail="Insufficient credits")
    
    # 1. Download File
    job_id = str(uuid.uuid4())
    internal_id = job_id 
    ext = Path(req.filename).suffix or ".wav" # Default to wav if missing
    if not ext.startswith("."): ext = "." + ext
    
    final_path = INPUT_DIR / f"{internal_id}{ext}"
    
    try:
        # Download from Firebase URL
        import requests
        with requests.get(req.url, stream=True) as r:
            r.raise_for_status()
            with open(final_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
    except Exception as e:
        print(f"Download Error: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to download file: {str(e)}")

    # 2. Init Job
    JOBS[job_id] = {
        "status": "queued",
        "progress": 0,
        "start_time": time.time(),
        "user_id": user["id"],
        "message": "Queued for separation..."
    }

    # 3. Start Pipeline
    background_tasks.add_task(run_separation_pipeline, job_id, final_path, req.filename, user)
    
    return {"job_id": job_id, "message": "Downloading & Processing..."}

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
    JOBS[job_id] = {
        "status": "queued", 
        "progress": 0, 
        "result": None, 
        "start_time": datetime.datetime.now().timestamp(),
        "owner": user["username"],
        "name": file.filename
    }
    
    def file_wrapper(jid, path, fname, usr):
        try:
            update_job(jid, "Processing Audio...", 10)
            res = core_process_track(path, fname, usr)
            JOBS[jid]["result"] = res
            update_job(jid, "completed", 100)
        except Exception as e:
            JOBS[jid]["status"] = "failed"
            JOBS[jid]["error"] = str(e)
            
    background_tasks.add_task(file_wrapper, job_id, input_path, file.filename, user)
    return {"job_id": job_id}

@app.get("/api/my_jobs")
def get_my_jobs(user: dict = Depends(get_current_user)):
    # Return active/recent jobs for this user
    # Sort by time desc
    my_list = []
    for jid, info in JOBS.items():
        if info.get("owner") == user["username"]:
            # Sanitize (remove sensitive internal paths if any, though result is safe)
            item = {
                "job_id": jid,
                "status": info["status"],
                "progress": info["progress"],
                "name": info.get("name", "Untitled"),
                "start_time": info["start_time"],
                "error": info.get("error")
            }
            if info["status"] == "completed":
                item["result"] = info["result"]
            my_list.append(item)
    
    # Sort: Newest first
    my_list.sort(key=lambda x: x["start_time"], reverse=True)
    return my_list

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
    JOBS[job_id] = {
        "status": "queued",
        "progress": 0, 
        "result": None, 
        "start_time": datetime.datetime.now().timestamp(),
        "owner": user["username"],
        "name": url # Will update to title later
    }
    
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
    
    set_subscription(user["id"], plan, credits_to_set)
    
    return {"message": f"Subscribed to {plan}", "credits_left": credits_to_set}

@app.get("/api/admin/users")
def admin_users(user: dict = Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT id, username, credits, plan, created_at, email FROM users")
    users = [dict(row) for row in c.fetchall()]
    conn.close()
    return {"users": users}

@app.get("/api/admin/stats")
def admin_stats(user: dict = Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    total_users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    conn.close()
    return {"total_users": total_users}

@app.delete("/api/admin/clean_system")
def admin_clean_system(user: dict = Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    
    # 1. Delete Jobs
    JOBS.clear()
    
    # 2. Delete DB Projects
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM projects")
    conn.commit()
    conn.close()
    
    # 3. Delete Files (Input/Output)
    def clean_dir(path: Path):
        for item in path.glob('*'):
            if item.is_file() and item.name != ".gitkeep":
                item.unlink()
            elif item.is_dir():
                shutil.rmtree(item)
    
    clean_dir(INPUT_DIR)
    clean_dir(OUTPUT_DIR)
    
    # Re-create htdemucs folder
    (OUTPUT_DIR / "htdemucs").mkdir(exist_ok=True)
    
    return {"message": "System Purged"}

@app.post("/api/dev/make_admin")
def dev_make_admin(user: dict = Depends(get_current_user)):
    # LOCAL DEV ONLY: Promote current user to admin
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (user["id"],))
    conn.commit()
    conn.close()
    return {"message": f"User {user['username']} is now Admin"}

# --- Static Mounts ---
app.mount("/stems", StaticFiles(directory=OUTPUT_DIR), name="stems")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static_explicit") # Fix for 404s
app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Changed default port to 3001 for local dev
    uvicorn.run(app, host="0.0.0.0", port=3001)
