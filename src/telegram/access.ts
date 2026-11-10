import type { Config } from "../config.ts";

// keep private and guest authorization independent at every entry point
export function authorized(config: Config, userId: number, guest = false): boolean {
  const mode = guest ? config.guestAccess : config.accessMode;
  return mode === "public" || (mode === "owner" && userId === config.adminId);
}

// bound per-user requests and cost without another service or unbounded key retention
export class RateLimiter {
  private readonly users = new Map<number, { count: number; start: number }>();
  // allow deterministic clock tests while applying the same production cost budget
  constructor(private readonly now: () => number = Date.now, private readonly limit = 6) {}
  // refuse bursts and cap bookkeeping so arbitrary identities cannot exhaust memory
  allow(userId: number): boolean {
    const now = this.now();
    for (const [id, item] of this.users) if (now - item.start >= 60000) this.users.delete(id);
    const current = this.users.get(userId);
    if (!current) {
      if (this.users.size >= 10000) return false;
      this.users.set(userId, { count: 1, start: now });
      return true;
    }
    return ++current.count <= this.limit;
  }
}
