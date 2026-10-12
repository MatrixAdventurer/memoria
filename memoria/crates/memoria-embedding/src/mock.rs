use async_trait::async_trait;
use memoria_core::{interfaces::EmbeddingProvider, MemoriaError};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Mock embedder for benchmarking and local/dev use when `EMBEDDING_PROVIDER` is
/// unset. Returns deterministic unit vectors based on a content hash.
///
/// # Upgrade note
/// The mixing algorithm changed in the fix for mock-vector collapse: the same
/// text now produces a **different** vector than older builds. Those L2
/// distances are typically ~1.4, well above the store's default ~0.3162
/// deduplication threshold, so posting identical content after an upgrade can
/// miss the old record and create a duplicate. Previously superseded records
/// are not restored automatically.
///
/// Supported recovery: rebuild / re-embed mock-backed memories (purge the user
/// or collection and re-ingest), or switch `EMBEDDING_PROVIDER` to a real
/// embedder before relying on cross-version dedup. Fresh installs are
/// unaffected.
pub struct MockEmbedder {
    dim: usize,
}

impl MockEmbedder {
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }
}

/// SplitMix64 step: cheap, well-distributed 64-bit mixing.
fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[async_trait]
impl EmbeddingProvider for MockEmbedder {
    async fn embed(&self, text: &str) -> Result<Vec<f32>, MemoriaError> {
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let seed = hasher.finish();
        // Generate a deterministic pseudo-random unit vector from the seed.
        // Each component needs its own well-mixed value: the previous
        // `(seed * C + i) as f32` rounded every component to the same float, so
        // all mock vectors collapsed to the same direction (cosine = +/-1) and
        // dedup/contradiction checks treated distinct memories as duplicates.
        let mut state = seed;
        let mut v: Vec<f32> = (0..self.dim)
            .map(|_| {
                state = splitmix64(state);
                // Top 24 bits -> [0, 1) exactly representable in f32.
                let x = (state >> 40) as f32 / (1u64 << 24) as f32;
                x * 2.0 - 1.0
            })
            .collect();
        // Normalize to unit vector
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        Ok(v)
    }

    fn dimension(&self) -> usize {
        self.dim
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[tokio::test]
    async fn distinct_texts_get_distinct_directions() {
        let e = MockEmbedder::new(1024);
        let texts = [
            "Alice likes green tea",
            "Server room is on floor 3",
            "Quarterly OKR review is in March",
        ];
        let mut vs = Vec::new();
        for t in texts {
            let v = e.embed(t).await.unwrap();
            assert_eq!(v.len(), 1024);
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-4, "not unit: {norm}");
            vs.push(v);
        }
        for i in 0..vs.len() {
            for j in (i + 1)..vs.len() {
                let c = cosine(&vs[i], &vs[j]).abs();
                assert!(c < 0.2, "texts {i} and {j} nearly collinear: cos={c}");
            }
        }
    }

    #[tokio::test]
    async fn same_text_is_deterministic() {
        let e = MockEmbedder::new(64);
        assert_eq!(e.embed("x").await.unwrap(), e.embed("x").await.unwrap());
    }

    /// Old algorithm (pre-SplitMix) vs new: L2 is above the default dedup
    /// threshold (~0.3162), so upgrades cannot rely on vector equality for the
    /// same text.
    fn legacy_collapsed_embed(dim: usize, text: &str) -> Vec<f32> {
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let seed = hasher.finish();
        let mut v: Vec<f32> = (0..dim)
            .map(|i| {
                let x = (seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(i as u64)) as f32
                    / u64::MAX as f32;
                x * 2.0 - 1.0
            })
            .collect();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }

    fn l2(a: &[f32], b: &[f32]) -> f32 {
        a.iter()
            .zip(b)
            .map(|(x, y)| {
                let d = x - y;
                d * d
            })
            .sum::<f32>()
            .sqrt()
    }

    #[tokio::test]
    async fn upgrade_changes_vectors_above_dedup_threshold() {
        const DEDUP_L2: f32 = 0.3162;
        let e = MockEmbedder::new(1024);
        for text in [
            "Alice likes green tea",
            "Server room is on floor 3",
            "Quarterly OKR review is in March",
        ] {
            let new_v = e.embed(text).await.unwrap();
            let old_v = legacy_collapsed_embed(1024, text);
            let dist = l2(&old_v, &new_v);
            assert!(
                dist > DEDUP_L2,
                "text {text:?}: old-vs-new L2 {dist} should exceed dedup threshold {DEDUP_L2}"
            );
        }
    }
}
