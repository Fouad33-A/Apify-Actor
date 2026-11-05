FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package*.json ./

RUN npm install --include=dev --audit=false

# Native open-source TikTok metadata extractor, no public Apify Actor dependency.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && python3 -m venv /opt/gallery-venv \
    && /opt/gallery-venv/bin/pip install --no-cache-dir 'gallery-dl>=1.32.0' 'yt-dlp>=2025.1.0' \
    && ln -s /opt/gallery-venv/bin/gallery-dl /usr/local/bin/gallery-dl \
    && rm -rf /var/lib/apt/lists/*
USER myuser

COPY --chown=myuser . ./

RUN npm run build

CMD npm run start:prod --silent