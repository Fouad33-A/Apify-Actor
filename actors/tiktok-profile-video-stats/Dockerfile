FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package*.json ./

RUN npm install --include=dev --audit=false

# Native open-source TikTok metadata extractor, no public Apify Actor dependency.
RUN python3 -m pip install --user --no-cache-dir 'gallery-dl>=1.32.0'

COPY --chown=myuser . ./

RUN npm run build

CMD npm run start:prod --silent