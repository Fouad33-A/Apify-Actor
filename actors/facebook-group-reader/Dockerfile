FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package.json package-lock.json ./
# Keep the Playwright version bundled with the Apify browser image while
# installing this Actor's remaining dependencies. The image sets
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so no second browser is downloaded.
RUN npm install --omit=dev --omit=optional

COPY --chown=myuser . ./

CMD ["npm", "start"]
