FROM node:20-slim

# FFmpeg + curl + フォントのみ（Chromium不要 — FFmpegで直接レンダリング）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./
RUN npm install

# Copy all source files
COPY . .

# Create necessary directories
RUN mkdir -p public output

# Expose port (Render sets PORT env automatically)
EXPOSE 10000

# Start the server
CMD ["npx", "tsx", "server.ts"]
