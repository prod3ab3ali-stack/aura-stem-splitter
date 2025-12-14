FROM python:3.9

# Install system dependencies (FFmpeg is critical)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first to leverage Docker cache
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create directories for app data with correct permissions for HF User (user 1000)
RUN mkdir -p input output && \
    chmod 777 input output

# Copy the rest of the application
COPY . .

# Grant permissions to the DB file location if it needs to be created
RUN chmod 777 /app

# Command to run the app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
