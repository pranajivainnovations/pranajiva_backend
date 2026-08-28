# Stage 1: Build
FROM node:20-alpine AS builder

# Medusa dependencies often need these to compile native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps) to run the build script
RUN npm install

COPY . .
# Run the medusa build command (creates the /dist folder)
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Only copy what is needed for runtime
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# 2. CRITICAL: Copy the config file (Medusa needs this to find the DB/Redis)
COPY medusa-config.js ./

# ADD THIS: Medusa often looks for these files/folders at runtime
COPY src/ ./src/

# Ensure we use your custom port from the .env
ENV PORT=9001
EXPOSE 9001

# Use the production start command

# ── Build provenance ──────────────────────────────────────────────────────────────────────────
# Declared in the RUNNER stage, deliberately, not the builder. The /api/build route reads these
# from process.env at request time, so they have to exist in the image that actually runs — a
# value set in the builder stage is discarded the moment the runner stage starts from a fresh
# base. (This is the mirror image of the NEXT_PUBLIC_* rule: those must be in the BUILDER stage
# because the bundler inlines them at compile time. Getting the two confused is what left GA
# missing from two production builds.)
#
# These are readable by anyone who can reach the endpoint. That is an accepted trade: a short
# commit hash from a private repo is not actionable on its own, and the alternative — a shared
# token in five more places — is exactly the kind of env plumbing that has already failed here.
ARG BUILD_COMMIT=unknown
ARG BUILD_BRANCH=unknown
ARG BUILD_TREE=unknown
ARG BUILD_TIME=unknown
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV BUILD_BRANCH=$BUILD_BRANCH
ENV BUILD_TREE=$BUILD_TREE
ENV BUILD_TIME=$BUILD_TIME
# CMD ["npm", "run", "start"]
CMD ["node", "dist/index.js"]