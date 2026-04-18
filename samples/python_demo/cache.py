"""Render cache with pluggable eviction policies."""

from typing import Any, Optional
from collections import OrderedDict


class EvictionPolicy:
    """Base class for cache eviction strategies."""

    def on_access(self, key: str):
        pass

    def on_insert(self, key: str):
        pass

    def choose_victim(self, keys) -> Optional[str]:
        return None


class LRUEvictionPolicy(EvictionPolicy):
    """Least-recently-used eviction."""

    def __init__(self):
        self._order = OrderedDict()

    def on_access(self, key: str):
        if key in self._order:
            self._order.move_to_end(key)

    def on_insert(self, key: str):
        self._order[key] = True
        self._order.move_to_end(key)

    def choose_victim(self, keys) -> Optional[str]:
        if self._order:
            return next(iter(self._order))
        return None

    def remove(self, key: str):
        self._order.pop(key, None)


class FIFOEvictionPolicy(EvictionPolicy):
    """First-in-first-out eviction."""

    def __init__(self):
        self._queue = []

    def on_insert(self, key: str):
        self._queue.append(key)

    def choose_victim(self, keys) -> Optional[str]:
        while self._queue:
            k = self._queue[0]
            if k in keys:
                return k
            self._queue.pop(0)
        return None

    def remove(self, key: str):
        if key in self._queue:
            self._queue.remove(key)


class RenderCache:
    """Fixed-size cache for rendered fragments."""

    def __init__(self, max_entries: int = 128,
                 policy: EvictionPolicy = None):
        self.max_entries = max_entries
        self.policy = policy or LRUEvictionPolicy()
        self._store = {}
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[Any]:
        if key in self._store:
            self._hits += 1
            self.policy.on_access(key)
            return self._store[key]
        self._misses += 1
        return None

    def put(self, key: str, value: Any):
        if key in self._store:
            self._store[key] = value
            self.policy.on_access(key)
            return
        if len(self._store) >= self.max_entries:
            self._evict()
        self._store[key] = value
        self.policy.on_insert(key)

    def _evict(self):
        victim = self.policy.choose_victim(set(self._store.keys()))
        if victim and victim in self._store:
            del self._store[victim]
            if hasattr(self.policy, "remove"):
                self.policy.remove(victim)

    def clear(self):
        self._store.clear()
        self._hits = 0
        self._misses = 0

    @property
    def hit_rate(self) -> float:
        total = self._hits + self._misses
        return self._hits / total if total > 0 else 0.0

    def stats(self) -> dict:
        return {
            "size": len(self._store),
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": self.hit_rate,
        }
