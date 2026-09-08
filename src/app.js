'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { config } = require('./config/env');
const ApiError = require('./utils/ApiError');
const routes = require('./routes');
const userContext = require('./middleware/userContext');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/curl requests (no Origin header) and configured origins.
      if (!origin || config.corsOrigin.includes('*') || config.corsOrigin.includes(origin)) {
        return callback(null, true);
      }
      // Outside production, accept any localhost port: Vite picks the next free
      // one (5174, 5175, …) whenever 5173 is taken, and blocking that only ever
      // breaks the developer's own browser.
      if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      // A blocked origin is a configuration problem, not a crash: answer 403
      // with the fix, so the browser console shows why instead of a bare 500.
      return callback(
        ApiError.forbidden(
          `Origin ${origin} is not allowed by CORS — add it to CORS_ORIGIN in backend/.env and restart the API`
        )
      );
    },
    credentials: true,
    // Every custom header the frontend sends must be listed here, or the
    // browser blocks the request outright when the two run on different origins.
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-user-name', 'x-user-role'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (!config.isProduction) app.use(morgan('dev'));

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  })
);

// Resolve the acting user for every request before it reaches a controller.
app.use(userContext);

app.get('/', (req, res) =>
  res.json({ success: true, message: 'DBA Utility API', version: '1.0.0', docs: '/api/health' })
);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
