const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || '';
const hasRedis = Boolean(redisUrl);
const memoryStore = new Map();

let redis = null;
if (hasRedis) {
  redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
}

async function connectRedis() {
  if (!redis) return;
  try {
    await redis.connect();
  } catch (error) {
    console.error('[REDIS] connect failed:', error.message);
  }
}

async function setJson(key, value, ttlSeconds) {
  if (redis && redis.status === 'ready') {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return;
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function getJson(key) {
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }
  const record = memoryStore.get(key);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return record.value;
}

async function delKey(key) {
  if (redis && redis.status === 'ready') {
    await redis.del(key);
    return;
  }
  memoryStore.delete(key);
}

module.exports = {
  connectRedis,
  delKey,
  getJson,
  hasRedis,
  setJson,
};
