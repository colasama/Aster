use std::collections::BTreeMap;

use crate::GeneratorShader;

impl GeneratorShader {
    /// Express normalization through length and division rather than a backend rsqrt intrinsic.
    pub(crate) fn ordered_normalization(
        source: &str,
        module: &naga::Module,
    ) -> Result<String, String> {
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(module)
        .map_err(|e| e.to_string())?;
        let mut edits = BTreeMap::new();
        let mut helpers = BTreeMap::<u8, (String, String)>::new();
        let functions = module.functions.iter().map(|(h, f)| (f, &info[h])).chain(
            module
                .entry_points
                .iter()
                .enumerate()
                .map(|(i, e)| (&e.function, info.get_entry_point(i))),
        );
        for (function, info) in functions {
            for (handle, expression) in function.expressions.iter() {
                if !matches!(
                    expression,
                    naga::Expression::Math {
                        fun: naga::MathFunction::Normalize,
                        ..
                    }
                ) {
                    continue;
                }
                let naga::TypeInner::Vector { size, scalar } =
                    info[handle].ty.inner_with(&module.types)
                else {
                    continue;
                };
                if *scalar != naga::Scalar::F32 {
                    continue;
                }
                let Some(span) = function.expressions.get_span(handle).to_range() else {
                    continue;
                };
                if !source
                    .get(span.clone())
                    .is_some_and(|s| s.starts_with("normalize"))
                {
                    continue;
                }
                let (name, _) = helpers.entry(*size as u8).or_insert_with(|| {
                    let ty = format!("vec{}f", *size as u8);
                    let mut name = format!("aster_native_normalize_{ty}");
                    while source.contains(&name) {
                        name.push('_');
                    }
                    let body = format!(
                        "\nfn {name}(value: {ty}) -> {ty} {{ return value / length(value); }}\n"
                    );
                    (name, body)
                });
                edits.insert(span.start, name.clone());
            }
        }
        let mut result = source.to_owned();
        for (start, name) in edits.into_iter().rev() {
            result.replace_range(start..start + "normalize".len(), &name);
        }
        for (_, body) in helpers.values() {
            result.push_str(body);
        }
        Ok(result)
    }

    /// Keep finite scalar/vector products separate from following additions during lowering.
    pub(crate) fn bounded_products(
        source: &str,
        module: &naga::Module,
        only: Option<&[&str]>,
    ) -> Result<String, String> {
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(module)
        .map_err(|e| e.to_string())?;
        let mut products = BTreeMap::new();
        let functions = module.functions.iter().map(|(h, f)| (f, &info[h])).chain(
            module
                .entry_points
                .iter()
                .enumerate()
                .map(|(i, e)| (&e.function, info.get_entry_point(i))),
        );
        for (function, info) in functions {
            for (handle, expression) in function.expressions.iter() {
                if !matches!(
                    expression,
                    naga::Expression::Binary {
                        op: naga::BinaryOperator::Multiply,
                        ..
                    }
                ) {
                    continue;
                }
                if only.is_some_and(|names| {
                    !function
                        .name
                        .as_deref()
                        .is_some_and(|name| names.contains(&name))
                }) {
                    continue;
                }
                let ty = match info[handle].ty.inner_with(&module.types) {
                    naga::TypeInner::Scalar(s) if *s == naga::Scalar::F32 => "f32".to_owned(),
                    naga::TypeInner::Vector { size, scalar } if *scalar == naga::Scalar::F32 => {
                        format!("vec{}f", *size as u8)
                    }
                    _ => continue,
                };
                let Some(range) = function.expressions.get_span(handle).to_range() else {
                    continue;
                };
                let text = source
                    .get(range.clone())
                    .ok_or("generator expression span invalid")?;
                if !text.contains('*') || text.contains("*=") {
                    continue;
                }
                products.insert((range.start, range.end), ty);
            }
        }
        let mut openings = BTreeMap::<usize, Vec<usize>>::new();
        let mut closings = BTreeMap::<usize, Vec<(usize, String)>>::new();
        for ((start, end), ty) in products {
            openings.entry(start).or_default().push(end);
            closings.entry(end).or_default().push((start, ty));
        }
        let positions = openings
            .keys()
            .chain(closings.keys())
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let mut result = String::new();
        let mut previous = 0;
        for position in positions {
            result.push_str(
                source
                    .get(previous..position)
                    .ok_or("generator expression boundaries overlap")?,
            );
            if let Some(values) = closings.get_mut(&position) {
                values.sort_by_key(|b| std::cmp::Reverse(b.0));
                for (_, ty) in values {
                    result.push_str(&format!("), {ty}(-3.402823466e38), {ty}(3.402823466e38))"));
                }
            }
            if let Some(values) = openings.get(&position) {
                for _ in values {
                    result.push_str("clamp((");
                }
            }
            previous = position;
        }
        result.push_str(&source[previous..]);
        Ok(result)
    }
}
