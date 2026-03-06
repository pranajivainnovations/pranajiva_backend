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
# CMD ["npm", "run", "start"]
CMD ["node", "dist/index.js"]