import { createClient, type RedisClientType } from 'redis';
import type { RedisCommands } from './scripted-redis-store.js';
import { ScriptedRedisSessionStore } from './scripted-redis-store.js';

class NodeRedisCommands implements RedisCommands {
  private connectPromise: Promise<unknown> | undefined;

  constructor(private readonly client: RedisClientType) {}

  private async connected(): Promise<RedisClientType> {
    if (!this.client.isOpen) {
      this.connectPromise ??= this.client.connect();
      await this.connectPromise;
    }
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return (await this.connected()).get(key);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await (await this.connected()).set(key, value, { EX: ttlSeconds });
  }

  async setNxEx(
    key: string,
    ttlSeconds: number,
    value: string,
  ): Promise<boolean> {
    const result = await (await this.connected()).set(key, value, {
      EX: ttlSeconds,
      NX: true,
    });
    return result === 'OK';
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length > 0) await (await this.connected()).del(keys);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<number> {
    const result = await (await this.connected()).eval(script, {
      keys,
      arguments: args,
    });
    return Number(result);
  }

  async incrementWithExpiry(key: string, windowSeconds: number): Promise<number> {
    const result = await this.eval(
      `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return count
      `,
      [key],
      [String(windowSeconds)],
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

export function createLocalRedisSessionStore(
  redisUrl: string,
  prefix: string,
): ScriptedRedisSessionStore {
  const client = createClient({ url: redisUrl });
  client.on('error', () => {
    // Command callers receive a typed availability error; do not log connection details.
  });
  return new ScriptedRedisSessionStore(prefix, new NodeRedisCommands(client));
}
