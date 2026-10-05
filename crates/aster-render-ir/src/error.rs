#[derive(Debug, thiserror::Error)]
pub enum IrError {
    #[error("Invalid root scene commands: {0}")]
    InvalidRootScene(String),
    #[error("Invalid layer effect: {0}")]
    InvalidLayerEffect(String),
    #[error("invalid effect execution: {0}")]
    InvalidEffectExecution(String),
    #[error("Invalid material binding: {0}")]
    InvalidMaterialBinding(String),
    #[error("FPLN header is truncated")]
    TruncatedHeader,
    #[error("FPLN magic is invalid")]
    InvalidMagic,
    #[error("Unsupported FPLN version {0}")]
    UnsupportedVersion(u16),
    #[error("Invalid FPLN header: {0}")]
    InvalidHeader(String),
    #[error("Container length does not match its header")]
    ContainerLengthMismatch,
    #[error("Transport limit exceeded: {0}")]
    LimitExceeded(String),
    #[error("Metadata is not valid UTF-8")]
    InvalidUtf8,
    #[error("Invalid typed JSON metadata: {0}")]
    InvalidJson(String),
    #[error("Metadata is not in canonical JSON byte form")]
    NonCanonicalMetadata,
    #[error("Integer is outside the JavaScript safe-integer domain")]
    InvalidSafeInteger,
    #[error("Rational values must be reduced with a positive denominator")]
    InvalidRational,
    #[error("Checked transport arithmetic overflowed")]
    ArithmeticOverflow,
    #[error("Blob count differs from the header, payloads or slices")]
    BlobCountMismatch,
    #[error("Blob element type does not match its concrete slice")]
    BlobTypeMismatch,
    #[error("Blob range is outside the container")]
    BlobRangeOutOfBounds,
    #[error("Blob offset is not 16-byte aligned")]
    BlobMisaligned,
    #[error("Blob ranges overlap or are not in physical order")]
    BlobOverlap,
    #[error("Padding is not zero or the layout is not tightly aligned")]
    InvalidPadding,
    #[error("Element count and byte length disagree")]
    ElementCountMismatch,
    #[error("Invalid post-process uniform payload: {0}")]
    InvalidPostUniforms(String),
    #[error("Invalid temporal text sample payload: {0}")]
    InvalidTemporalText(String),
    #[error("This transport contract cannot describe a complete renderer plan")]
    IncompleteFramePlan,
    #[error("Resource content hash differs from its descriptor and bytes")]
    HashMismatch,
    #[error("Resource hash is already bound to different content")]
    ResourceConflict,
    #[error("Resource budget exceeded: used={used}, requested={requested}, budget={budget}")]
    ResourceBudgetExceeded {
        used: u64,
        requested: u64,
        budget: u64,
    },
    #[error("Resource is pinned by a submission: {0}")]
    ResourceInUse(String),
    #[error("Referenced resource is absent: {0}")]
    MissingResource(String),
    #[error("Invalid resource contract: {0}")]
    InvalidResource(String),
    #[error("Resource lease is invalid or has already been released")]
    InvalidLease,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl IrError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRootScene(_) => "invalid_root_scene",
            Self::InvalidLayerEffect(_) => "invalid_layer_effect",
            Self::InvalidEffectExecution(_) => "invalid_effect_execution",
            Self::InvalidMaterialBinding(_) => "invalid_material_binding",
            Self::TruncatedHeader => "truncated_header",
            Self::InvalidMagic => "invalid_magic",
            Self::UnsupportedVersion(_) => "unsupported_version",
            Self::InvalidHeader(_) => "invalid_header",
            Self::ContainerLengthMismatch => "container_length_mismatch",
            Self::LimitExceeded(_) => "limit_exceeded",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::InvalidJson(_) => "invalid_json",
            Self::NonCanonicalMetadata => "non_canonical_metadata",
            Self::InvalidSafeInteger => "invalid_safe_integer",
            Self::InvalidRational => "invalid_rational",
            Self::ArithmeticOverflow => "arithmetic_overflow",
            Self::BlobCountMismatch => "blob_count_mismatch",
            Self::BlobTypeMismatch => "blob_type_mismatch",
            Self::BlobRangeOutOfBounds => "blob_range_out_of_bounds",
            Self::BlobMisaligned => "blob_misaligned",
            Self::BlobOverlap => "blob_overlap",
            Self::InvalidPadding => "invalid_padding",
            Self::ElementCountMismatch => "element_count_mismatch",
            Self::InvalidPostUniforms(_) => "invalid_post_uniforms",
            Self::InvalidTemporalText(_) => "invalid_temporal_text",
            Self::IncompleteFramePlan => "incomplete_frame_plan",
            Self::HashMismatch => "hash_mismatch",
            Self::ResourceConflict => "resource_conflict",
            Self::ResourceBudgetExceeded { .. } => "resource_budget_exceeded",
            Self::ResourceInUse(_) => "resource_in_use",
            Self::MissingResource(_) => "missing_resource",
            Self::InvalidResource(_) => "invalid_resource",
            Self::InvalidLease => "invalid_lease",
            Self::Io(_) => "io_error",
        }
    }
}
