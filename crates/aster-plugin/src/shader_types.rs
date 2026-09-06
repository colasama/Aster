use naga::{Handle, Module, ScalarKind, Type, TypeInner, VectorSize};

pub(crate) trait ShaderTypes {
    fn is_vector(&self, ty: Handle<Type>, size: VectorSize, kind: ScalarKind) -> bool;
    fn is_scalar(&self, ty: Handle<Type>, kind: ScalarKind) -> bool;
    fn is_atomic_uint(&self, ty: Handle<Type>) -> bool;
}

impl ShaderTypes for Module {
    fn is_vector(&self, ty: Handle<Type>, size: VectorSize, kind: ScalarKind) -> bool {
        matches!(self.types[ty].inner,
            TypeInner::Vector { size: found, scalar: naga::Scalar { kind: found_kind, width: 4 } }
            if found == size && found_kind == kind)
    }
    fn is_scalar(&self, ty: Handle<Type>, kind: ScalarKind) -> bool {
        matches!(self.types[ty].inner,
            TypeInner::Scalar(naga::Scalar { kind: found, width: 4 }) if found == kind)
    }
    fn is_atomic_uint(&self, ty: Handle<Type>) -> bool {
        matches!(
            self.types[ty].inner,
            TypeInner::Atomic(naga::Scalar {
                kind: ScalarKind::Uint,
                width: 4
            })
        )
    }
}
