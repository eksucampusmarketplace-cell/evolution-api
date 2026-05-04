import { CacheConf, CacheConfRedis, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

class Redis {
  private logger = new Logger('Redis');
  private client: RedisClientType = null;
  private conf: CacheConfRedis;
  private connected = false;
  private lastErrorLog = 0;
  private errorCount = 0;
  private static readonly ERROR_LOG_INTERVAL_MS = 60_000;

  constructor() {
    this.conf = configService.get<CacheConf>('CACHE')?.REDIS;
  }

  getConnection(): RedisClientType {
    if (!this.conf?.ENABLED) {
      return null;
    }

    if (!this.conf?.URI) {
      this.logger.warn('CACHE_REDIS_ENABLED is true but CACHE_REDIS_URI is empty — skipping Redis connection');
      return null;
    }

    if (this.connected) {
      return this.client;
    } else {
      this.client = createClient({
        url: this.conf.URI,
      });

      this.client.on('connect', () => {
        this.logger.verbose('redis connecting');
      });

      this.client.on('ready', () => {
        this.logger.verbose('redis ready');
        this.connected = true;
        this.errorCount = 0;
      });

      this.client.on('error', () => {
        this.connected = false;
        this.errorCount++;
        const now = Date.now();
        if (now - this.lastErrorLog >= Redis.ERROR_LOG_INTERVAL_MS) {
          const suffix = this.errorCount > 1 ? ` (repeated ${this.errorCount} times)` : '';
          this.logger.error(`redis disconnected${suffix}`);
          this.lastErrorLog = now;
          this.errorCount = 0;
        }
      });

      this.client.on('end', () => {
        this.logger.verbose('redis connection ended');
        this.connected = false;
      });

      try {
        this.client.connect();
        this.connected = true;
      } catch (e) {
        this.connected = false;
        this.logger.error('redis connect exception caught: ' + e);
        return null;
      }

      return this.client;
    }
  }
}

export const redisClient = new Redis();
