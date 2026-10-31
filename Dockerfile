FROM apify/actor-node-playwright-chrome:20-1.60.0

COPY --chown=myuser package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY --chown=myuser . ./

CMD ["npm", "start"]
