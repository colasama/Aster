mod payload;
mod references;
mod structure;

use crate::{
    BundleDependencies, DecodeLimits, ElementType, FramePlanSliceV1, IrError, OwnedFpln,
    ResourceDescriptor, ResourceHash, ResourceRegistry,
};
use payload::Payload;
use references::PlanReferences;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use structure::Structure;

#[derive(Clone, Debug)]
pub struct PlanComparison {
    pub relative: f64,
    pub absolute: f64,
    pub max_plans: usize,
    pub max_path_bytes: usize,
}
impl Default for PlanComparison {
    fn default() -> Self {
        Self {
            relative: 1e-5,
            absolute: 1e-6,
            max_plans: 65536,
            max_path_bytes: 8192,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct PlanDifference {
    pub path: String,
    pub kind: String,
    pub expected: String,
    pub actual: String,
}
#[derive(Debug, Default, Serialize)]
pub struct PlanComparisonReport {
    pub equal: bool,
    pub compared_plans: usize,
    pub compared_float_lanes: u64,
    pub tolerated_float_differences: u64,
    pub first_difference: Option<PlanDifference>,
}
struct ResourceLists {
    a: Vec<ResourceHash>,
    b: Vec<ResourceHash>,
    path: String,
}

impl PlanComparison {
    pub fn compare(
        &self,
        a: &OwnedFpln,
        a_resources: &ResourceRegistry,
        b: &OwnedFpln,
        b_resources: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<PlanComparisonReport, IrError> {
        if !self.relative.is_finite()
            || !(0.0..=1e-5).contains(&self.relative)
            || !self.absolute.is_finite()
            || !(0.0..=1e-6).contains(&self.absolute)
            || self.max_plans == 0
            || self.max_plans > 65536
            || self.max_path_bytes == 0
            || self.max_path_bytes > 8192
        {
            return Err(IrError::LimitExceeded(
                "plan comparison configuration".into(),
            ));
        }
        let a_nested = self.authenticate(&a.metadata, a_resources, limits)?;
        let b_nested = self.authenticate(&b.metadata, b_resources, limits)?;
        let mut queue = VecDeque::from([(None, None, String::new())]);
        let mut visited = BTreeSet::new();
        let mut a_to_b = BTreeMap::new();
        let mut b_to_a = BTreeMap::new();
        let mut lists = Vec::new();
        let mut report = PlanComparisonReport::default();
        while let Some((a_hash, b_hash, path)) = queue.pop_front() {
            if !visited.insert((a_hash.clone(), b_hash.clone())) {
                continue;
            }
            if visited.len() > self.max_plans || path.len() > self.max_path_bytes {
                return Err(IrError::LimitExceeded("plan comparison traversal".into()));
            }
            let left = match &a_hash {
                Some(hash) => a_nested
                    .get(hash)
                    .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?,
                None => a,
            };
            let right = match &b_hash {
                Some(hash) => b_nested
                    .get(hash)
                    .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?,
                None => b,
            };
            let mut lm = left.metadata.clone();
            let mut rm = right.metadata.clone();
            let mut refs = BTreeMap::new();
            let mut pairs = Vec::new();
            PlanReferences::visit(&mut lm, |p, h, c| {
                refs.insert(p, (h.clone(), c));
            });
            PlanReferences::visit(&mut rm, |p, h, c| {
                if let Some((a, expected)) = refs.get(&p)
                    && *expected == c
                {
                    pairs.push((a.clone(), h.clone(), format!("{path}{p}")));
                    *h = a.clone();
                }
            });
            lists.push(ResourceLists {
                a: std::mem::take(&mut lm.resources),
                b: std::mem::take(&mut rm.resources),
                path: format!("{path}/resources"),
            });
            if let Some(d) = Structure::first(
                &serde_json::to_value(&lm).map_err(|e| IrError::InvalidJson(e.to_string()))?,
                &serde_json::to_value(&rm).map_err(|e| IrError::InvalidJson(e.to_string()))?,
                &path,
            ) {
                report.first_difference = Some(d);
                return Ok(report);
            }
            report.compared_plans += 1;
            if let Some(d) = Payload::compare(left, right, &path, self, &mut report)? {
                report.first_difference = Some(d);
                return Ok(report);
            }
            for (ah, bh, path) in pairs {
                if a_to_b.get(&ah).is_some_and(|v| v != &bh)
                    || b_to_a.get(&bh).is_some_and(|v| v != &ah)
                {
                    report.first_difference = Some(PlanDifference {
                        path,
                        kind: "plan_alias".into(),
                        expected: ah.0,
                        actual: bh.0,
                    });
                    return Ok(report);
                }
                if a_resources.descriptor(&ah)? != b_resources.descriptor(&bh)? {
                    report.first_difference = Some(PlanDifference {
                        path,
                        kind: "plan_resource_descriptor".into(),
                        expected: format!("{:?}", a_resources.descriptor(&ah)?),
                        actual: format!("{:?}", b_resources.descriptor(&bh)?),
                    });
                    return Ok(report);
                }
                a_to_b.insert(ah.clone(), bh.clone());
                b_to_a.insert(bh.clone(), ah.clone());
                queue.push_back((Some(ah), Some(bh), path));
            }
        }
        for mut list in lists {
            for hash in &mut list.b {
                if let Some(mapped) = b_to_a.get(hash) {
                    *hash = mapped.clone();
                }
            }
            list.b.sort();
            if list.a != list.b {
                report.first_difference = Structure::first(
                    &serde_json::to_value(list.a)
                        .map_err(|e| IrError::InvalidJson(e.to_string()))?,
                    &serde_json::to_value(list.b)
                        .map_err(|e| IrError::InvalidJson(e.to_string()))?,
                    &list.path,
                );
                return Ok(report);
            }
        }
        report.equal = true;
        Ok(report)
    }

    fn authenticate(
        &self,
        root: &FramePlanSliceV1,
        resources: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<BTreeMap<ResourceHash, OwnedFpln>, IrError> {
        resources.validate_references(root)?;
        let mut nested = BTreeMap::new();
        BundleDependencies::default().validate_with(root, resources, limits, |hash, plan, _| {
            nested.insert(hash, plan);
        })?;
        if nested.len() >= self.max_plans {
            return Err(IrError::LimitExceeded(
                "nested comparison plan count".into(),
            ));
        }
        for (hash, plan) in &nested {
            match resources.descriptor(hash)? {
                ResourceDescriptor::Buffer(d) if d.element_type == ElementType::U8 => {}
                _ => {
                    return Err(IrError::InvalidResource(
                        "nested plan must use byte-buffer resources".into(),
                    ));
                }
            }
            self.check_contracts(&plan.metadata, &nested)?;
        }
        self.check_contracts(root, &nested)?;
        Ok(nested)
    }

    fn check_contracts(
        &self,
        metadata: &FramePlanSliceV1,
        nested: &BTreeMap<ResourceHash, OwnedFpln>,
    ) -> Result<(), IrError> {
        let mut copy = metadata.clone();
        let mut valid = true;
        PlanReferences::visit(&mut copy, |_, hash, contract| {
            valid &= nested
                .get(hash)
                .is_some_and(|p| p.metadata.contract_level == contract);
        });
        if !valid {
            return Err(IrError::InvalidResource(
                "nested plan contract differs from its typed role".into(),
            ));
        }
        Ok(())
    }
}
