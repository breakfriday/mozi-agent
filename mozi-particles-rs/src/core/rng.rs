//! Deterministic randomness: no `rand` dependency, reproducible sampling and choreography.
use std::collections::HashMap;

pub struct LcgRng(u64);

impl LcgRng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 32) as u32 as f32) / (u32::MAX as f32)
    }

    pub fn next_usize(&mut self, bound: usize) -> usize {
        if bound <= 1 {
            return 0;
        }
        (self.next_f32() * (bound as f32)).floor().min((bound - 1) as f32) as usize
    }
}

/// Non-repeating shuffled bag picker (matching Terse's `_bagPick`).
pub struct BagPicker {
    bags: HashMap<&'static str, Vec<u32>>,
    last: HashMap<&'static str, u32>,
    rng: LcgRng,
}

impl BagPicker {
    pub fn new() -> Self {
        Self {
            bags: HashMap::new(),
            last: HashMap::new(),
            rng: LcgRng::new(0x5EED_CAFE_1234_5678),
        }
    }

    pub fn pick(&mut self, key: &'static str, pool: &[u32]) -> u32 {
        if pool.is_empty() {
            return 0;
        }
        if pool.len() == 1 {
            return pool[0];
        }
        let bag = self.bags.entry(key).or_default();
        if bag.is_empty() {
            let mut refilled = pool.to_vec();
            for i in (1..refilled.len()).rev() {
                let j = self.rng.next_usize(i + 1);
                refilled.swap(i, j);
            }
            if let Some(&prev) = self.last.get(key) {
                if refilled.len() > 1 && refilled.last() == Some(&prev) {
                    let len = refilled.len();
                    refilled.swap(0, len - 1);
                }
            }
            *bag = refilled;
        }
        let chosen = bag.pop().unwrap_or(pool[0]);
        self.last.insert(key, chosen);
        chosen
    }

    pub fn next_unit_dir(&mut self) -> [f32; 2] {
        let angle = self.rng.next_f32() * std::f32::consts::TAU;
        [angle.cos(), angle.sin()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bag_picker_never_repeats_back_to_back() {
        let mut bags = BagPicker::new();
        let pool: Vec<u32> = (0..9).collect();
        let mut prev = u32::MAX;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..90 {
            let v = bags.pick("in", &pool);
            assert_ne!(v, prev);
            seen.insert(v);
            prev = v;
        }
        assert_eq!(seen.len(), 9);
    }
}
