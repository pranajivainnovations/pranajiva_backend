const dotenv = require("dotenv");

let ENV_FILE_NAME = "";
switch (process.env.NODE_ENV) {
  case "production":
    ENV_FILE_NAME = ".env.production";
    break;
  case "staging":
    ENV_FILE_NAME = ".env.staging";
    break;
  case "test":
    ENV_FILE_NAME = ".env.test";
    break;
  case "development":
  default:
    ENV_FILE_NAME = ".env";
    break;
}

ENV_FILE_NAME = ".env";

try {
  dotenv.config({ path: process.cwd() + "/" + ENV_FILE_NAME });
} catch (e) {}

// CORS when consuming Medusa from admin
const ADMIN_CORS =
  process.env.ADMIN_CORS || "http://localhost:7001,http://localhost:7001";

// CORS to avoid issues when consuming Medusa from a client
const STORE_CORS = process.env.STORE_CORS || "http://localhost:3000";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost/medusa-starter-default";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Connection options for every Redis client this app opens.
 *
 * Without these the process DIES when a Redis connection drops. The event bus uses BullMQ, which
 * holds a blocking `bzpopmin` open for minutes at a time with zero bytes on the wire. Anything in
 * the path that reaps idle connections — a home or office NAT, a load balancer, a flaky
 * resolver — closes that socket, ioredis raises an error with no handler attached, and Node exits.
 * Observed locally every 30-90 minutes, and under a few minutes when the network is unstable.
 *
 * The production host on AWS talks to the same Redis without a NAT in between and holds its
 * connections for ~23 hours, so it has never hit this. That is luck, not design: the same drop
 * would kill it too, and the failure mode is a hard process exit rather than a degraded service.
 * These options are correct in both places.
 */
const REDIS_OPTIONS = {
  // Send TCP keepalives so a blocking read is never mistaken for a dead connection.
  keepAlive: 30000,
  // Reconnect with backoff instead of throwing. Returning a number = "retry after N ms"; never
  // returning null, because giving up is what kills the process.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  // BullMQ requires this: its blocking commands must not be capped, or they surface an error on
  // every reconnect instead of resuming.
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 10000,
};

const plugins = [
  `medusa-fulfillment-manual`,
  `medusa-payment-manual`,
  // S3 File Provider for product image uploads
  {
    resolve: `medusa-file-s3`,
    options: {
      s3_url: process.env.S3_URL || "https://s3.amazonaws.com",
      bucket: process.env.S3_BUCKET || "",
      region: process.env.S3_REGION || "us-east-1",
      access_key_id: process.env.S3_ACCESS_KEY_ID || "",
      secret_access_key: process.env.S3_SECRET_ACCESS_KEY || "",
      cache_control: "max-age=3600", // Cache for 1 hour
    },
  },
  // File Local Disabled - using S3 instead
  /*
  {
    resolve: `@medusajs/file-local`,
    options: {
      upload_dir: "uploads",
    },
  },
  */
  {
    resolve: "@medusajs/admin",
    /** @type {import('@medusajs/admin').PluginOptions} */
    options: {
      autoRebuild: true,
      develop: {
        open: process.env.OPEN_BROWSER !== "false",
      },
      backend: process.env.MEDUSA_BACKEND_URL || "http://localhost:9001"
    },
  },
];

const modules = {
  eventBus: {
    resolve: "@medusajs/event-bus-redis",
    options: {
      redisUrl: REDIS_URL,
      // This is the one that matters — the event bus holds the long blocking reads.
      redisOptions: REDIS_OPTIONS,
    }
  },
  cacheService: {
    resolve: "@medusajs/cache-redis",
    options: {
      redisUrl: REDIS_URL,
      redisOptions: REDIS_OPTIONS,
    }
  },
};

/** @type {import('@medusajs/medusa').ConfigModule["projectConfig"]} */
const projectConfig = {
  jwt_secret: process.env.JWT_SECRET || "supersecret",
  cookie_secret: process.env.COOKIE_SECRET || "supersecret",
  store_cors: STORE_CORS,
  database_url: DATABASE_URL,
  admin_cors: ADMIN_CORS,
  redis_url: REDIS_URL,
  // Medusa opens its own Redis client for sessions from projectConfig — same options, or that one
  // client keeps the original failure mode and takes the process down on its own.
  redis_options: REDIS_OPTIONS,
  port: process.env.PORT || 9001,
};

const featureFlags = {
  product_categories: true,
};

const serverConfig = {
  port: process.env.PORT || 9001,
  host: "0.0.0.0"
};

/** @type {import('@medusajs/medusa').ConfigModule} */
module.exports = {
  projectConfig,
  plugins,
  modules,
  featureFlags,
  serverConfig,
};
