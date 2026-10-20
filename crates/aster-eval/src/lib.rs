//! Time-addressable evaluation of persisted editor properties.

mod audio;
mod bundle;
pub use bundle::BundleMediaPixels;
pub use bundle::{
    BundleEffect, BundleGenerator, FrameBundleInput, FrameOutputPlans, NativeBundle,
    SurfaceBundleScene,
};
pub use bundle::{BundleLimits, BundleResources};
mod camera;
mod cloner;
mod curve;
mod effects;
mod expression;
mod generator;
pub use generator::GeneratorCatalog;
pub use scene::{GeneratorFrameSettings, SurfaceProgramFrames, SurfaceProgramInputs};
mod geometry;
mod javascript;
mod lighting;
mod mesh;
mod motion;
mod path;
mod plan;
pub use motion::{MotionSettings, ShutterInterval};
pub use plan::MaterialTextureSettings;
pub use plan::{BufferVisualization, FrameOutputSettings};
pub use plan::{DepthAttachments, DepthSettings, SurfacePostSettings};
pub use plan::{EffectPreparation, PreparedEffect, PreparedEffectProgram};
pub use plan::{TemporalRasterPass, TemporalRasterSample};
pub use scene::FrameOutputContext;
pub use scene::{FrameSceneInputs, PreparedSceneFrame};
pub use scene::{MaterialResources, MaterialTextureSources};
pub use scene::{ProjectFrameAllocator, ProjectFrameResources};
pub use scene::{ProjectResourceRequests, ResourcePreparationOperation, ResourceRequestContext};
pub use scene::{RetainedRasterContext, RetainedRasterKind, RetainedRasterRequest};
mod property;
mod scalar;
mod scene;
mod shape_graph;
mod text;
mod transform;
mod vector;
mod vertex;

pub use audio::{
    AudioAnalysis, AudioAnalysisLimits, AudioSamples, MonoAudioReader, SpectrumPlan, SpectrumWindow,
};
pub use camera::{
    CameraBasis, CameraOptics, CameraPose, CameraProjection, CameraProjector, CameraTrack,
    EvaluatedCamera, ProjectedCameraPoint,
};

pub use cloner::{ClonerFrame, ClonerInstance, ClonerLimits, ClonerTrack};
pub use effects::{
    EffectColorTrack, EffectFrame, EffectLimits, EffectMaskInput, EffectProgram, EffectTrack,
    PixelParameter,
};
pub use expression::{
    ExpressionBinding, ExpressionContext, ExpressionError, ExpressionLimits, ExpressionProgram,
    TextExpressionBinding, TextExpressionContext,
};
pub use generator::{
    GeneratorContext, GeneratorDefinition, GeneratorDeviceLimits, GeneratorInputs,
    GeneratorInvocation, GeneratorParameterDefinition, GeneratorProgramSource,
    NativeGeneratorProgram,
};
pub use geometry::{GeometryContext, LayerGeometry};
pub use lighting::SceneLighting;
pub use mesh::{GeometryLimits, MeshGeometry};
pub use path::{
    EvaluatedPath, PathGeometry, PathLimits, PathTessellator, PathTrack, PathVertex, Point2,
    TrimmedPolyline,
};
pub use plan::{
    EffectContext, EffectExecutionPlan, FramePlanRequest, LutPlan, NativePlan, RootItemKind,
    RootSceneInput, RootStackItem,
};
pub use property::PropertyTrack;
pub use scalar::ScalarTrack;
pub use scene::AuxiliaryBudget;
pub use scene::RenderIdentity;
pub use scene::RootResourceBindings;
pub use scene::SceneFramePlans;
pub use scene::{
    AudioComposition, AudioMix, AudioMixLimits, AudioMixRequest, AudioPcm, AudioSourceRequest,
    ClipProtection, CompositionAudioReader,
};
pub use scene::{
    EvaluatedSceneLayer, LayerClock, PrecompositionSurface, SceneGeometry, SceneGeometryRecord,
    SceneLimits, SceneProject,
};
pub use scene::{
    PrecompositionSources, SurfaceBudget, SurfaceLimits, SurfacePreparation, SurfaceRequest,
    SurfaceSource, SurfaceTarget,
};
pub use scene::{ShapeGraphEvaluation, TextGeometryBounds};
pub use scene::{SurfaceFrame, SurfaceFramePlans};
pub use scene::{
    TextExposureFrame, TextExposurePlan, TextExposureRequest, TextExposureSample, TextLayouts,
};
pub use shape_graph::{FlattenedShapePath, ResolvedMaskPath, ShapeGraphLimits, ShapeGraphTrack};
pub use text::{
    TextAnimatorFrame, TextAnimatorTrack, TextBaseStyle, TextCharacter, TextCollation,
    TextLayoutUnit, TextLimits, TextSelectorFrame, TextSelectorTrack, TextUnitContext,
};
pub use transform::{EvaluatedTransform, TransformTrack};

#[derive(Clone, Debug, clap::Args)]
pub struct EvaluationLimits {
    #[arg(long, default_value_t = Self::default().max_keyframes)]
    pub max_keyframes: usize,
}

impl Default for EvaluationLimits {
    fn default() -> Self {
        Self {
            max_keyframes: 10_000,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EvaluationError {
    #[error("Invalid animation property: {0}")]
    InvalidProperty(String),
    #[error("Evaluation time must be finite")]
    InvalidTime,
    #[error("Invalid scene: {0}")]
    InvalidScene(String),
    #[error("Native evaluation is not yet available for {0}")]
    Unsupported(&'static str),
}
