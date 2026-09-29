FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package.json ./
RUN npm install --omit=dev --omit=optional

COPY --chown=myuser . ./

CMD ["npm", "start"]
