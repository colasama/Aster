use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ResourceDescriptor;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct PooledResourceId(u64);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct ResourcePoolStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub leased_resources: usize,
    pub cached_resources: usize,
    pub estimated_bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ResourceSnapshot {
    pub id: PooledResourceId,
    pub descriptor: ResourceDescriptor,
    pub leased: bool,
    pub last_used_tick: u64,
}

struct PoolEntry<T> {
    descriptor: ResourceDescriptor,
    resource: T,
    leased: bool,
    last_used_tick: u64,
}

pub struct ResourcePool<T> {
    budget_bytes: u64,
    // Keep the sum exact even when multiple descriptors saturate at u64::MAX.
    estimated_bytes: u128,
    leased_resources: usize,
    tick: u64,
    next_id: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
    entries: BTreeMap<PooledResourceId, PoolEntry<T>>,
    available: BTreeMap<ResourceDescriptor, Vec<PooledResourceId>>,
}

impl<T> ResourcePool<T> {
    pub fn new(budget_bytes: u64) -> Self {
        Self {
            budget_bytes,
            estimated_bytes: 0,
            leased_resources: 0,
            tick: 0,
            next_id: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
            entries: BTreeMap::new(),
            available: BTreeMap::new(),
        }
    }

    pub fn acquire_with(
        &mut self,
        descriptor: ResourceDescriptor,
        create: impl FnOnce(ResourceDescriptor) -> T,
    ) -> PooledResourceId {
        self.tick += 1;
        if let Some(id) = self.available.get_mut(&descriptor).and_then(Vec::pop)
            && let Some(entry) = self.entries.get_mut(&id)
        {
            entry.leased = true;
            entry.last_used_tick = self.tick;
            self.hits += 1;
            self.leased_resources += 1;
            return id;
        }
        let id = PooledResourceId(self.next_id);
        self.next_id += 1;
        self.entries.insert(
            id,
            PoolEntry {
                descriptor,
                resource: create(descriptor),
                leased: true,
                last_used_tick: self.tick,
            },
        );
        self.misses += 1;
        self.estimated_bytes += u128::from(descriptor.estimated_bytes());
        self.leased_resources += 1;
        id
    }

    pub fn get(&self, id: PooledResourceId) -> Option<&T> {
        self.entries.get(&id).map(|entry| &entry.resource)
    }

    pub fn get_mut(&mut self, id: PooledResourceId) -> Option<&mut T> {
        self.entries.get_mut(&id).map(|entry| &mut entry.resource)
    }

    pub fn release(&mut self, id: PooledResourceId) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if !entry.leased {
            return false;
        }
        self.tick += 1;
        entry.leased = false;
        self.leased_resources -= 1;
        entry.last_used_tick = self.tick;
        self.available.entry(entry.descriptor).or_default().push(id);
        self.trim_to_budget();
        true
    }

    pub fn set_budget(&mut self, budget_bytes: u64) {
        self.budget_bytes = budget_bytes;
        self.trim_to_budget();
    }

    pub fn statistics(&self) -> ResourcePoolStatistics {
        ResourcePoolStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            leased_resources: self.leased_resources,
            cached_resources: self.entries.len() - self.leased_resources,
            estimated_bytes: self.estimated_bytes.min(u128::from(u64::MAX)) as u64,
            budget_bytes: self.budget_bytes,
        }
    }

    pub fn snapshots(&self) -> Vec<ResourceSnapshot> {
        self.entries
            .iter()
            .map(|(id, entry)| ResourceSnapshot {
                id: *id,
                descriptor: entry.descriptor,
                leased: entry.leased,
                last_used_tick: entry.last_used_tick,
            })
            .collect()
    }

    fn trim_to_budget(&mut self) {
        while self.estimated_bytes > u128::from(self.budget_bytes) {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, entry)| !entry.leased)
                .min_by_key(|(_, entry)| entry.last_used_tick)
                .map(|(id, entry)| (*id, entry.descriptor));
            let Some((id, descriptor)) = oldest else {
                break;
            };
            self.entries.remove(&id);
            self.estimated_bytes -= u128::from(descriptor.estimated_bytes());
            if let Some(ids) = self.available.get_mut(&descriptor) {
                ids.retain(|candidate| *candidate != id);
                if ids.is_empty() {
                    self.available.remove(&descriptor);
                }
            }
            self.evictions += 1;
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct ObjectCacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub capacity: usize,
}

pub struct GpuObjectCache<K, V> {
    capacity: usize,
    tick: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
    entries: BTreeMap<K, (V, u64)>,
}

impl<K: Clone + Ord, V> GpuObjectCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            tick: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
            entries: BTreeMap::new(),
        }
    }

    pub fn get_or_insert_with(&mut self, key: K, create: impl FnOnce() -> V) -> &V {
        self.tick += 1;
        if self.entries.contains_key(&key) {
            self.hits += 1;
        } else {
            self.misses += 1;
            if self.entries.len() == self.capacity
                && let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (_, tick))| tick)
                    .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
                self.evictions += 1;
            }
        }
        let entry = self
            .entries
            .entry(key)
            .or_insert_with(|| (create(), self.tick));
        entry.1 = self.tick;
        &entry.0
    }

    pub fn invalidate(&mut self, key: &K) -> bool {
        self.entries.remove(key).is_some()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn statistics(&self) -> ObjectCacheStatistics {
        ObjectCacheStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: self.entries.len(),
            capacity: self.capacity,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TextureFormat;

    impl ResourceDescriptor {
        fn pool_fixture(width: u32) -> ResourceDescriptor {
            ResourceDescriptor {
                width,
                height: 1,
                format: TextureFormat::Rgba8Unorm,
                samples: 1,
                transient: true,
            }
        }
    }
    #[test]
    fn reuses_matching_released_resources() {
        let mut pool = ResourcePool::new(1024);
        let first = pool.acquire_with(ResourceDescriptor::pool_fixture(16), |_| "first".to_owned());
        assert!(pool.release(first));
        let second = pool.acquire_with(ResourceDescriptor::pool_fixture(16), |_| {
            "second".to_owned()
        });
        assert_eq!(first, second);
        assert_eq!(pool.get(second).map(String::as_str), Some("first"));
        assert_eq!(pool.statistics().hits, 1);
    }

    #[test]
    fn evicts_oldest_available_resources_to_budget() {
        let mut pool = ResourcePool::new(64);
        let first = pool.acquire_with(ResourceDescriptor::pool_fixture(16), |_| 1);
        let second = pool.acquire_with(ResourceDescriptor::pool_fixture(16), |_| 2);
        assert!(pool.release(first));
        assert!(pool.release(second));
        pool.set_budget(64);
        let statistics = pool.statistics();
        assert_eq!(statistics.cached_resources, 1);
        assert_eq!(statistics.evictions, 1);
    }

    #[test]
    fn accounting_tracks_reuse_eviction_and_failed_releases() {
        let mut pool = ResourcePool::new(256);
        let descriptor = ResourceDescriptor::pool_fixture(16);
        let a = pool.acquire_with(descriptor, |_| 1);
        let b = pool.acquire_with(descriptor, |_| 2);
        let c = pool.acquire_with(descriptor, |_| 3);
        assert_eq!(pool.statistics().estimated_bytes, 192);
        assert_eq!(pool.statistics().leased_resources, 3);
        assert!(pool.release(a));
        assert!(pool.release(b));
        assert!(!pool.release(b));
        assert!(!pool.release(PooledResourceId(99)));
        assert_eq!(pool.acquire_with(descriptor, |_| 4), b);
        assert_eq!(pool.statistics().leased_resources, 2);
        assert_eq!(pool.statistics().cached_resources, 1);
        pool.set_budget(0);
        assert!(pool.get(a).is_none());
        assert_eq!(pool.get(b), Some(&2));
        assert_eq!(pool.get(c), Some(&3));
        assert_eq!(pool.statistics().estimated_bytes, 128);
        assert!(pool.release(b));
        assert!(pool.release(c));
        assert_eq!(pool.statistics().estimated_bytes, 0);
        assert_eq!(pool.statistics().leased_resources, 0);
        assert_eq!(pool.statistics().cached_resources, 0);
        assert_eq!(pool.statistics().evictions, 3);
        let fresh = pool.acquire_with(descriptor, |_| 5);
        assert_eq!(pool.get(fresh), Some(&5));
    }

    #[test]
    fn accounting_recovers_after_totals_exceed_u64() {
        let descriptor = ResourceDescriptor {
            width: u32::MAX,
            height: u32::MAX,
            ..ResourceDescriptor::pool_fixture(1)
        };
        let mut pool = ResourcePool::new(u64::MAX);
        let a = pool.acquire_with(descriptor, |_| ());
        let b = pool.acquire_with(descriptor, |_| ());
        assert_eq!(pool.statistics().estimated_bytes, u64::MAX);
        assert!(pool.release(a));
        assert!(pool.get(a).is_none());
        assert!(pool.get(b).is_some());
        assert_eq!(pool.statistics().estimated_bytes, u64::MAX);
        pool.set_budget(0);
        assert!(pool.release(b));
        assert_eq!(pool.statistics().estimated_bytes, 0);
    }

    #[test]
    fn caches_gpu_objects_with_lru_eviction() {
        let mut cache = GpuObjectCache::new(2);
        assert_eq!(*cache.get_or_insert_with("shader-a", || 1), 1);
        assert_eq!(*cache.get_or_insert_with("shader-b", || 2), 2);
        assert_eq!(*cache.get_or_insert_with("shader-a", || 3), 1);
        assert_eq!(*cache.get_or_insert_with("shader-c", || 3), 3);
        let statistics = cache.statistics();
        assert_eq!(statistics.hits, 1);
        assert_eq!(statistics.evictions, 1);
        assert_eq!(statistics.entries, 2);
    }
}
