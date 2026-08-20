use super::*;

#[must_use]
pub fn bloom() -> RenderGraph {
    RenderGraph {
        api_version: GRAPH_API_VERSION,
        temporary_textures: vec![
            temporary(
                "bright",
                half_frame(),
                [TextureUsage::Sampled, TextureUsage::RenderAttachment],
            ),
            temporary(
                "blur_h",
                half_frame(),
                [TextureUsage::Sampled, TextureUsage::Storage],
            ),
            temporary(
                "blur_v",
                half_frame(),
                [TextureUsage::Sampled, TextureUsage::Storage],
            ),
        ],
        passes: vec![
            render(
                "threshold",
                "bloom/threshold.wgsl",
                vec![TextureRef::Source],
                TextureRef::Temporary("bright".into()),
                vec![],
            ),
            compute(
                "blur_horizontal",
                TextureRef::Temporary("bright".into()),
                TextureRef::Temporary("blur_h".into()),
                vec!["threshold".into()],
            ),
            compute(
                "blur_vertical",
                TextureRef::Temporary("blur_h".into()),
                TextureRef::Temporary("blur_v".into()),
                vec!["blur_horizontal".into()],
            ),
            render(
                "composite",
                "bloom/composite.wgsl",
                vec![TextureRef::Source, TextureRef::Temporary("blur_v".into())],
                TextureRef::Output,
                vec!["blur_vertical".into()],
            ),
        ],
    }
}

#[must_use]
pub fn multi_pass_blur() -> RenderGraph {
    RenderGraph {
        api_version: GRAPH_API_VERSION,
        temporary_textures: vec![temporary(
            "horizontal",
            TextureExtent::FullFrame,
            [TextureUsage::Sampled, TextureUsage::RenderAttachment],
        )],
        passes: vec![
            render(
                "horizontal",
                "blur/horizontal.wgsl",
                vec![TextureRef::Source],
                TextureRef::Temporary("horizontal".into()),
                vec![],
            ),
            render(
                "vertical",
                "blur/vertical.wgsl",
                vec![TextureRef::Temporary("horizontal".into())],
                TextureRef::Output,
                vec!["horizontal".into()],
            ),
        ],
    }
}

fn half_frame() -> TextureExtent {
    TextureExtent::Scale {
        numerator: 1,
        denominator: 2,
    }
}

fn temporary(
    id: &str,
    extent: TextureExtent,
    usage: impl IntoIterator<Item = TextureUsage>,
) -> TemporaryTexture {
    TemporaryTexture {
        id: id.into(),
        extent,
        format: TextureFormat::Rgba16Float,
        usage: usage.into_iter().collect(),
    }
}

fn render(
    id: &str,
    shader: &str,
    sampled_inputs: Vec<TextureRef>,
    output: TextureRef,
    depends_on: Vec<String>,
) -> GraphPass {
    GraphPass::Render {
        id: id.into(),
        shader: shader.into(),
        vertex_entry: "vs_main".into(),
        fragment_entry: "fs_main".into(),
        sampled_inputs,
        color_outputs: vec![output],
        depends_on,
    }
}

fn compute(id: &str, input: TextureRef, output: TextureRef, depends_on: Vec<String>) -> GraphPass {
    GraphPass::Compute {
        id: id.into(),
        shader: "bloom/blur.wgsl".into(),
        entry_point: "main".into(),
        sampled_inputs: vec![input],
        storage_outputs: vec![output.clone()],
        dispatch: ComputeDispatch::ForTexture {
            texture: output,
            workgroup_size: [8, 8, 1],
        },
        depends_on,
    }
}
