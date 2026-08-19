import winston from "winston";
import config from "../config.js";

const level = config.logLevel || "info";

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const { service: _s, ...rest } = meta;
        const metaStr = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
        return `${timestamp} ${level}: ${stack || message}${metaStr}`;
      })
    ),
  }),
];

if (process.env.LOG_FILE) {
  transports.push(new winston.transports.File({
    filename: process.env.LOG_FILE,
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    maxsize: 10 * 1024 * 1024,
    maxFiles: 5,
  }));
}

export const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "outreach-service" },
  transports,
});

export function setLogLevel(newLevel) {
  logger.level = newLevel;
}
