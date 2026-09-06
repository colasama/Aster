use crate::DecodedFrame;
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PacketKey {
    pub stream_index: u32,
    pub decode_timestamp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameKey {
    pub stream_index: u32,
    pub presentation_timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub presentation_timestamp: i64,
    pub duration: i64,
    pub keyframe: bool,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Debug)]
struct CacheEntry<V> {
    value: V,
    bytes: u64,
    age: u64,
}

#[derive(Debug)]
struct WeightedLru<K, V> {
    entries: BTreeMap<K, CacheEntry<V>>,
    budget: u64,
    used: u64,
    clock: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K: Ord + Clone, V> WeightedLru<K, V> {
    fn new(budget: u64) -> Self {
        Self {
            entries: BTreeMap::new(),
            budget,
            used: 0,
            clock: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        self.clock = self.clock.saturating_add(1);
        if let Some(entry) = self.entries.get_mut(key) {
            self.hits = self.hits.saturating_add(1);
            entry.age = self.clock;
            Some(&entry.value)
        } else {
            self.misses = self.misses.saturating_add(1);
            None
        }
    }

    fn insert(&mut self, key: K, value: V, bytes: u64) -> bool {
        if bytes > self.budget {
            return false;
        }
        self.clock = self.clock.saturating_add(1);
        if let Some(previous) = self.entries.remove(&key) {
            self.used -= previous.bytes;
        }
        while self.used > self.budget - bytes {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.age)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.used -= removed.bytes;
                self.evictions = self.evictions.saturating_add(1);
            }
        }
        self.entries.insert(
            key,
            CacheEntry {
                value,
                bytes,
                age: self.clock,
            },
        );
        self.used += bytes;
        true
    }

    fn statistics(&self) -> CacheStatistics {
        CacheStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: self.entries.len(),
            bytes: self.used,
            budget_bytes: self.budget,
        }
    }
}

#[derive(Debug)]
pub struct PacketCache(WeightedLru<PacketKey, Packet>);

/// Compressed packets waiting for decoder submission, indexed by exact decode timestamp.
pub type DecodeCache = PacketCache;

impl PacketCache {
    pub fn new(budget_bytes: u64) -> Self {
        Self(WeightedLru::new(budget_bytes))
    }
    pub fn get(&mut self, key: &PacketKey) -> Option<&Packet> {
        self.0.get(key)
    }
    pub fn insert(&mut self, key: PacketKey, packet: Packet) -> bool {
        let bytes = packet.bytes.len() as u64;
        self.0.insert(key, packet, bytes)
    }
    pub fn statistics(&self) -> CacheStatistics {
        self.0.statistics()
    }
}

#[derive(Debug)]
pub struct FrameCache(WeightedLru<FrameKey, DecodedFrame>);

impl FrameCache {
    pub fn new(budget_bytes: u64) -> Self {
        Self(WeightedLru::new(budget_bytes))
    }
    pub fn get(&mut self, key: &FrameKey) -> Option<&DecodedFrame> {
        self.0.get(key)
    }
    pub fn insert(&mut self, key: FrameKey, frame: DecodedFrame) -> bool {
        let bytes = (frame.bytes.len() as u64).max(frame.descriptor.allocation_size);
        self.0.insert(key, frame, bytes)
    }
    pub fn statistics(&self) -> CacheStatistics {
        self.0.statistics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_budget_cannot_overflow_the_byte_counter() {
        let mut cache = WeightedLru::new(u64::MAX);
        assert!(cache.insert(0, (), u64::MAX));
        assert!(cache.insert(1, (), 1));
        assert_eq!(cache.statistics().bytes, 1);
        assert_eq!(cache.statistics().evictions, 1);
    }
}
