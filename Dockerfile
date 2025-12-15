FROM python:3.9

# 1. Install System Dependencies (FFmpeg + Certs for Network Fix)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    ca-certificates \
    dnsutils \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*
    
# Update Certs
RUN update-ca-certificates

# 2. Setup Working Directory & Permissions
# Hugging Face Spaces runs as user 1000. We must ensure they own the folder.
WORKDIR /app
RUN chown 1000:1000 /app

# Switch to non-root user
USER 1000
ENV HOME=/app
ENV PATH="/app/.local/bin:$PATH"

# 3. Install Python Dependencies
COPY --chown=1000 requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 4. Copy Application Code
COPY --chown=1000 . .

# 5. Create necessary directories
RUN mkdir -p input output && chmod 777 input output

# 6. Expose Port 7860 (Standard for Hugging Face Spaces)
EXPOSE 7860

# 7. Start the Application
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
