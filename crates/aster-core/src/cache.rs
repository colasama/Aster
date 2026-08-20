use std::collections::{HashMap, VecDeque};

use aster_timeline::Time;
use uuid::Uuid;

use crate::NodeId;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct EvaluationResolution {
    pub width: u32,
    pub height: u32,
}

impl EvaluationResolution {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum TimeCacheKey {
    Invariant,
    At { value: i64, scale: u32 },
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ResolutionCacheKey {
    Invariant,
    At(EvaluationResolution),
}

/// Identifies a deterministic node result across source revision, time, and resolution.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct EvaluationCacheKey {
    node: NodeId,
    revision: u64,
    time: TimeCacheKey,
    resolution: ResolutionCacheKey,
}

impl EvaluationCacheKey {
    pub const fn invariant(node: NodeId, revision: u64) -> Self {
        Self {
            node,
            revision,
            time: TimeCacheKey::Invariant,
            resolution: ResolutionCacheKey::Invariant,
        }
    }

    pub const fn resolution_dependent(
        node: NodeId,
        revision: u64,
        resolution: EvaluationResolution,
    ) -> Self {
        Self {
            node,
            revision,
            time: TimeCacheKey::Invariant,
            resolution: ResolutionCacheKey::At(resolution),
        }
    }

    pub const fn time_dependent(
        node: NodeId,
        revision: u64,
        time: Time,
        resolution: EvaluationResolution,
    ) -> Self {
        Self {
            node,
            revision,
            time: TimeCacheKey::At {
                value: time.value(),
                scale: time.scale(),
            },
            resolution: ResolutionCacheKey::At(resolution),
        }
    }

    pub const fn node(self) -> NodeId {
        self.node
    }

    pub const fn revision(self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub insertions: u64,
    pub evictions: u64,
    pub invalidations: u64,
    pub entries: usize,
    pub capacity: usize,
}

impl CacheStatistics {
    pub fn hit_rate(self) -> f32 {
        let attempts = self.hits + self.misses;
        if attempts == 0 {
            return 1.0;
        }
        self.hits as f32 / attempts as f32
    }
}

/// A bounded LRU cache for evaluated node outputs.
///
/// Values are generic so the same policy can cache CPU scene snapshots, render-graph plans, or
/// lightweight GPU resource handles without moving frame pixels back to the CPU.
#[derive(Clone, Debug)]
pub struct EvaluationCache<T> {
    capacity: usize,
    entries: HashMap<EvaluationCacheKey, T>,
    recency: VecDeque<EvaluationCacheKey>,
    statistics: CacheStatistics,
}

impl<T> EvaluationCache<T> {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            entries: HashMap::with_capacity(capacity),
            recency: VecDeque::with_capacity(capacity),
            statistics: CacheStatistics {
                capacity,
                ..CacheStatistics::default()
            },
        }
    }

    pub fn get(&mut self, key: EvaluationCacheKey) -> Option<&T> {
        if !self.entries.contains_key(&key) {
            self.statistics.misses += 1;
            return None;
        }
        self.statistics.hits += 1;
        self.touch(key);
        self.entries.get(&key)
    }

    pub fn insert(&mut self, key: EvaluationCacheKey, value: T) -> Option<T> {
        self.statistics.insertions += 1;
        if self.entries.contains_key(&key) {
            self.touch(key);
            return self.entries.insert(key, value);
        }
        if self.entries.len() == self.capacity
            && let Some(evicted) = self.recency.pop_front()
        {
            self.entries.remove(&evicted);
            self.statistics.evictions += 1;
        }
        self.recency.push_back(key);
        self.entries.insert(key, value)
    }

    pub fn invalidate_node(&mut self, node: NodeId) -> usize {
        let before = self.entries.len();
        self.entries.retain(|key, _| key.node != node);
        self.recency.retain(|key| key.node != node);
        let removed = before - self.entries.len();
        self.statistics.invalidations += removed as u64;
        removed
    }

    pub fn invalidate_nodes(&mut self, nodes: impl IntoIterator<Item = NodeId>) -> usize {
        let nodes: std::collections::HashSet<Uuid> = nodes.into_iter().collect();
        if nodes.is_empty() {
            return 0;
        }
        let before = self.entries.len();
        self.entries.retain(|key, _| !nodes.contains(&key.node));
        self.recency.retain(|key| !nodes.contains(&key.node));
        let removed = before - self.entries.len();
        self.statistics.invalidations += removed as u64;
        removed
    }

    pub fn clear(&mut self) {
        let removed = self.entries.len();
        self.entries.clear();
        self.recency.clear();
        self.statistics.invalidations += removed as u64;
    }

    pub fn statistics(&self) -> CacheStatistics {
        CacheStatistics {
            entries: self.entries.len(),
            ..self.statistics
        }
    }

    fn touch(&mut self, key: EvaluationCacheKey) {
        self.recency.retain(|candidate| *candidate != key);
        self.recency.push_back(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timed(node: NodeId, frame: i64, width: u32) -> EvaluationCacheKey {
        EvaluationCacheKey::time_dependent(
            node,
            1,
            Time::new(frame, 60).unwrap(),
            EvaluationResolution::new(width, 1080),
        )
    }

    #[test]
    fn time_and_resolution_are_part_of_the_cache_key() {
        let node = Uuid::new_v4();
        assert_ne!(timed(node, 1, 1920), timed(node, 2, 1920));
        assert_ne!(timed(node, 1, 1920), timed(node, 1, 1280));
    }

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let node = Uuid::new_v4();
        let a = timed(node, 1, 1920);
        let b = timed(node, 2, 1920);
        let c = timed(node, 3, 1920);
        let mut cache = EvaluationCache::new(2);
        cache.insert(a, "a");
        cache.insert(b, "b");
        assert_eq!(cache.get(a), Some(&"a"));
        cache.insert(c, "c");
        assert_eq!(cache.get(b), None);
        assert_eq!(cache.get(a), Some(&"a"));
        assert_eq!(cache.statistics().evictions, 1);
    }

    #[test]
    fn invalidates_every_variant_of_a_dirty_node() {
        let dirty = Uuid::new_v4();
        let clean = Uuid::new_v4();
        let mut cache = EvaluationCache::new(8);
        cache.insert(timed(dirty, 1, 1920), 1);
        cache.insert(timed(dirty, 2, 1920), 2);
        let clean_key = timed(clean, 1, 1920);
        cache.insert(clean_key, 3);
        assert_eq!(cache.invalidate_node(dirty), 2);
        assert_eq!(cache.get(clean_key), Some(&3));
        assert_eq!(cache.statistics().invalidations, 2);
    }
}
