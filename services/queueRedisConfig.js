const config = require('../config.json');

function getQueueRedisConfig() {
  const db = Number.isInteger(config.redis?.db) ? config.redis.db : 10;

  const redisConfig = {
    host: config.redis.host,
    port: config.redis.port,
    db
  };
  // Include password when Redis requires authentication
  if (config.redis?.password != null && config.redis.password !== '') {
    redisConfig.password = config.redis.password;
  }
  return redisConfig;
}

module.exports = {
  getQueueRedisConfig
};
