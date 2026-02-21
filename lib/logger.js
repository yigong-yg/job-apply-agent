'use strict';

const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const logFilePath = path.join(logsDir, `${today}.log`);

// Create a multi-stream logger: stdout (pretty in dev, JSON in prod) + file
const streams = [];

// Always write JSON to file
streams.push({
  stream: fs.createWriteStream(logFilePath, { flags: 'a' }),
  level: 'debug',
});

// Write to stdout as well
if (process.env.NODE_ENV !== 'test') {
  streams.push({
    stream: process.stdout,
    level: 'info',
  });
}

const logger = pino(
  {
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams)
);

module.exports = logger;
