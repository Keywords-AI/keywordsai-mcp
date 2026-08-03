import { Redis } from '@upstash/redis';
import type { RedisCommands } from './scripted-redis-store.js';
import { ScriptedRedisSessionStore } from './scripted-redis-store.js';

class UpstashRedisCommands implements RedisCommands {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<string | null> {
    const value = await this.client.get<unknown>(key);
    if (value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.client.set(key, value, { ex: ttlSeconds });
  }

  async setNxEx(
    key: string,
    ttlSeconds: number,
    value: string,
  ): Promise<boolean> {
    return await this.client.set(key, value, {
      ex: ttlSeconds,
      nx: true,
    }) === 'OK';
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<number> {
    return Number(await this.client.eval(script, keys, args));
  }

  async incrementWithExpiry(key: string, windowSeconds: number): Promise<number> {
    return this.eval(
      `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return count
      `,
      [key],
      [String(windowSeconds)],
    );
  }
}

export function createUpstashSessionStore(
  url: string,
  token: string,
  prefix: string,
): ScriptedRedisSessionStore {
  return new ScriptedRedisSessionStore(
    prefix,
    new UpstashRedisCommands(new Redis({ url, token })),
  );
}
