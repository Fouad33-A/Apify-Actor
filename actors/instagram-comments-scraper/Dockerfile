FROM apify/actor-node:20
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY . ./
CMD ["npm","start"]
