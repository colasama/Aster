use std::{
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use crate::{AtomicFile, ProjectError};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiskCacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct DiskCacheBenchmark {
    pub bytes: u64,
    pub writes: usize,
    pub elapsed: Duration,
}

pub struct DiskCache {
    root: PathBuf,
    budget_bytes: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl DiskCache {
    const CACHE_EXTENSION: &str = "aster-cache";
    pub fn open(root: impl AsRef<Path>, budget_bytes: u64) -> Result<Self, ProjectError> {
        let root = root.as_ref().to_owned();
        fs::create_dir_all(&root)?;
        let mut cache = Self {
            root,
            budget_bytes,
            hits: 0,
            misses: 0,
            evictions: 0,
        };
        cache.trim_to_budget()?;
        Ok(cache)
    }

    pub fn get(&mut self, key: &str) -> Result<Option<Vec<u8>>, ProjectError> {
        let path = self.path(key)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.misses += 1;
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let size = file.metadata()?.len();
        if size > self.budget_bytes {
            fs::remove_file(path)?;
            self.misses += 1;
            return Ok(None);
        }
        let Some(capacity) = usize::try_from(size).ok() else {
            fs::remove_file(path)?;
            self.misses += 1;
            return Ok(None);
        };
        let mut bytes = Vec::with_capacity(capacity);
        BufReader::new(file)
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != size {
            self.misses = self.misses.saturating_add(1);
            return Ok(None);
        }
        File::options()
            .write(true)
            .open(path)?
            .set_modified(SystemTime::now())?;
        self.hits += 1;
        Ok(Some(bytes))
    }

    pub fn put(&mut self, key: &str, bytes: &[u8]) -> Result<bool, ProjectError> {
        let destination = self.path(key)?;
        if bytes.len() as u64 > self.budget_bytes {
            return Ok(false);
        }
        AtomicFile::write(&destination, |file| file.write_all(bytes))?;
        self.trim_to_budget()?;
        Ok(true)
    }

    pub fn remove(&mut self, key: &str) -> Result<bool, ProjectError> {
        let path = self.path(key)?;
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(path)?;
        Ok(true)
    }

    pub fn set_budget(&mut self, budget_bytes: u64) -> Result<(), ProjectError> {
        self.budget_bytes = budget_bytes;
        self.trim_to_budget()
    }

    pub fn statistics(&self) -> Result<DiskCacheStatistics, ProjectError> {
        let entries = self.entries()?;
        Ok(DiskCacheStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: entries.len(),
            bytes: entries
                .iter()
                .fold(0_u64, |total, entry| total.saturating_add(entry.bytes)),
            budget_bytes: self.budget_bytes,
        })
    }

    pub fn benchmark(
        &mut self,
        writes: usize,
        bytes_per_write: usize,
    ) -> Result<DiskCacheBenchmark, ProjectError> {
        let payload = vec![0x5a; bytes_per_write];
        let started = Instant::now();
        let mut completed = 0;
        let mut bytes = 0_u64;
        for index in 0..writes {
            let key = format!("benchmark_{index:08}");
            if !self.put(&key, &payload)? {
                break;
            }
            completed += 1;
            bytes = bytes.saturating_add(bytes_per_write as u64);
        }
        Ok(DiskCacheBenchmark {
            bytes,
            writes: completed,
            elapsed: started.elapsed(),
        })
    }

    fn path(&self, key: &str) -> Result<PathBuf, ProjectError> {
        if key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(ProjectError::InvalidCacheKey);
        }
        Ok(self.root.join(format!("{key}.{}", Self::CACHE_EXTENSION)))
    }

    fn trim_to_budget(&mut self) -> Result<(), ProjectError> {
        let mut entries = self.entries()?;
        entries.sort_by_key(|entry| entry.modified);
        let mut bytes: u64 = entries
            .iter()
            .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
        for entry in entries {
            if bytes <= self.budget_bytes {
                break;
            }
            fs::remove_file(entry.path)?;
            bytes = bytes.saturating_sub(entry.bytes);
            self.evictions += 1;
        }
        Ok(())
    }

    fn entries(&self) -> Result<Vec<CacheEntry>, ProjectError> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some(Self::CACHE_EXTENSION) {
                continue;
            }
            let metadata = entry.metadata()?;
            if metadata.is_file() {
                entries.push(CacheEntry {
                    path,
                    bytes: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                });
            }
        }
        Ok(entries)
    }
}

struct CacheEntry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn cache_root() -> PathBuf {
        std::env::temp_dir().join(format!("aster-disk-cache-{}", Uuid::new_v4()))
    }

    #[test]
    fn caches_atomically_and_reports_hits_and_misses() -> Result<(), Box<dyn std::error::Error>> {
        let root = cache_root();
        let mut cache = DiskCache::open(&root, 1024)?;
        assert!(cache.put("frame_0001", b"frame")?);
        assert_eq!(cache.get("frame_0001")?, Some(b"frame".to_vec()));
        assert_eq!(cache.get("missing")?, None);
        let statistics = cache.statistics()?;
        assert_eq!(
            (statistics.hits, statistics.misses, statistics.entries),
            (1, 1, 1)
        );
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn evicts_least_recently_used_entries_to_budget() -> Result<(), Box<dyn std::error::Error>> {
        let root = cache_root();
        let mut cache = DiskCache::open(&root, 8)?;
        cache.put("old", b"1234")?;
        std::thread::sleep(Duration::from_millis(2));
        cache.put("new", b"5678")?;
        cache.get("old")?;
        cache.set_budget(4)?;
        assert_eq!(cache.get("old")?, Some(b"1234".to_vec()));
        assert_eq!(cache.get("new")?, None);
        assert_eq!(cache.statistics()?.evictions, 1);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn rejects_traversal_and_returns_a_benchmark_report() -> Result<(), Box<dyn std::error::Error>>
    {
        let root = cache_root();
        let mut cache = DiskCache::open(&root, 1024 * 1024)?;
        assert!(matches!(
            cache.put("../escape", b"x"),
            Err(ProjectError::InvalidCacheKey)
        ));
        let report = cache.benchmark(4, 1024)?;
        assert_eq!((report.writes, report.bytes), (4, 4096));
        assert!(report.elapsed > Duration::ZERO);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
