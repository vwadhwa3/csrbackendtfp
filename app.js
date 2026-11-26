// Load env before anything reads process.env
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const winston = require("winston");
const client = require("prom-client");

const { db, getPool } = require("./config/db");

// Routes
const authRoutes = require("./routes/auth");
const csrRoutes = require("./routes/csr");
const applicationRoutes = require("./routes/applications");

const app = express();

/* ===================== LOGGER ===================== */

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

/* ===================== PROMETHEUS ===================== */

client.collectDefaultMetrics();

const httpRequestCounter = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
});

/* ===================== CORE SETTINGS ===================== */

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ===================== CORS ===================== */

const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:5175", // SPOC frontend
  "https://theflyingpanda.io",
  "https://theflyingpandatestingtfs.web.app",
];

const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = envOrigins.length > 0 ? envOrigins : defaultOrigins;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true, // lets the browser send the auth `token` cookie
    maxAge: 86400,
  }),
);

/* ===================== HELMET ===================== */

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...allowedOrigins],
        styleSrc: ["'self'", "'unsafe-inline'", ...allowedOrigins],
        imgSrc: ["'self'", "data:", ...allowedOrigins],
        fontSrc: ["'self'", ...allowedOrigins],
        connectSrc: ["'self'", ...allowedOrigins],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer-when-downgrade" },
  }),
);

/* ===================== BODY PARSING ===================== */

app.use(express.json({ limit: process.env.BODY_LIMIT || "1mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.BODY_LIMIT || "1mb" }));

/* ===================== REQUEST METRICS ===================== */

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : "unmatched",
      status: res.statusCode,
    };

    end(labels);
    httpRequestCounter.inc(labels);

    logger.info({
      message: "HTTP request",
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ip: req.ip,
    });
  });

  next();
});

/* ===================== ROUTES ===================== */

app.use("/api/auth", authRoutes);
app.use("/api/csr", csrRoutes);
app.use("/api/applications", applicationRoutes);

app.get("/health", async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) {
      throw new Error("Database pool is not initialized");
    }

    await pool.query("SELECT 1;");

    return res.status(200).json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error({ message: "Health check failed", error: error.message });

    return res.status(503).json({
      status: "error",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

const safeEqual = (a = "", b = "") => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

app.get("/metrics", async (req, res) => {
  const configuredSecret = process.env.METRICS_SECRET;

  if (!configuredSecret || !safeEqual(req.get("x-metrics-key"), configuredSecret)) {
    return res.status(403).send("Forbidden");
  }

  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

/* ===================== FALLBACK HANDLERS ===================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

app.use((err, req, res, next) => {
  logger.error({
    message: "Unhandled error",
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.originalUrl,
  });

  res.status(err.status || 500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  });
});

/* ===================== STARTUP ===================== */

let server;

const startServer = async () => {
  try {
    await db();

    if (!getPool()) {
      throw new Error("Database pool is not initialized");
    }

    console.log("Database is working. CSRTFPBACKEND");

    const PORT = process.env.PORT || 3000;
    server = app.listen(PORT, () => {
      logger.info({ message: `Server running on port ${PORT}` });
    });
  } catch (err) {
    logger.error({ message: "Database connection failed", error: err.message });
    process.exit(1);
  }
};

const shutdown = (signal) => {
  logger.info({ message: `Received ${signal}, shutting down gracefully` });

  const finish = async () => {
    try {
      const pool = getPool();
      if (pool) await pool.end();
    } catch (err) {
      logger.error({ message: "Error closing database pool", error: err.message });
    } finally {
      process.exit(0);
    }
  };

  if (server) {
    server.close(finish);
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    finish();
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (require.main === module) {
  startServer();
}

module.exports = app;
