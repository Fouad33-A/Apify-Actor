FROM apify/actor-node:20
COPY --chown=myuser package*.json ./
RUN npm install --omit=dev --no-package-lock --audit=false
COPY --chown=myuser . ./
CMD npm start --silent
