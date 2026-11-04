FROM apify/actor-node:20

COPY --chown=myuser package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY --chown=myuser . ./

CMD ["npm", "start"]
