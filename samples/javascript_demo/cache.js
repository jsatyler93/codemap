export class TTLCache {
  constructor(ttlMs = 1500) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const found = this.store.get(key);
    if (!found) return undefined;
    if (Date.now() - found.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return found.value;
  }

  set(key, value) {
    this.store.set(key, { value, at: Date.now() });
  }

  clearExpired() {
    for (const [key, entry] of this.store.entries()) {
      if (Date.now() - entry.at > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}
