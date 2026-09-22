FROM docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
WORKDIR /app
COPY package.json ./package.json
COPY dist ./dist
# Runtime code must stay readable when the build host uses a restrictive umask.
RUN chmod -R a=rX /app
USER node
ENTRYPOINT ["node", "/app/dist/repository-credentials.js"]
