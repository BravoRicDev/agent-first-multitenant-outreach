import { logger } from "./logger.js";

const MEMORY_LIMIT_MB = 800;
const WARN_THRESHOLD_MB = 700;

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
  };
}

export function checkMemory() {
  const { heapUsedMB } = getMemoryUsage();
  if (heapUsedMB > WARN_THRESHOLD_MB) {
    logger.warn("Memoria alta", { heapUsedMB, threshold: WARN_THRESHOLD_MB });
  }
  if (heapUsedMB > MEMORY_LIMIT_MB) {
    logger.error("Limite memoria superato, throw", { heapUsedMB, limit: MEMORY_LIMIT_MB });
    throw new Error(`Limite memoria superato: ${heapUsedMB}MB > ${MEMORY_LIMIT_MB}MB`);
  }
}
