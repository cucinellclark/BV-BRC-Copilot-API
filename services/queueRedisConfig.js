const config = require('../config.json');
const { createLogger } = require('./logger');

const logger = createLogger('QueueRedisConfig');

function getQueueCategory() {
  const configuredCategory = config.queue?.category;

  if (configuredCategory === undefined || configuredCategory === null || configuredCategory === '') {
    return Number.isInteger(config.redis?.db) ? config.redis.db : 0;
  }

  const category = Number(configuredCategory);
  if (category === 0 || category === 1) {
    return category;
  }

  logger.warn('Invalid queue.category in config, falling back to redis.db/default', {
    configuredCategory,
    fallbackDb: Number.isInteger(config.redis?.db) ? config.redis.db : 0
  });
  return Number.isInteger(config.redis?.db) ? config.redis.db : 0;
}

function getQueueRedisConfig() {
  return {
    host: config.redis.host,
    port: config.redis.port,
    db: getQueueCategory()
  };
}

module.exports = {
  getQueueCategory,
  getQueueRedisConfig
};

