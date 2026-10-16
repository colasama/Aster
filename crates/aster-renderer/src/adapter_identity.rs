use aster_render_ir::AdapterLuid;

pub(crate) struct AdapterSelection;

impl AdapterSelection {
    pub(crate) fn matches(adapter: &wgpu::Adapter, expected: Option<AdapterLuid>) -> bool {
        let Some(expected) = expected else {
            return true;
        };
        #[cfg(windows)]
        {
            // The guard retains the HAL adapter; querying its descriptor never changes ownership.
            let Some(native) = (unsafe { adapter.as_hal::<wgpu::hal::api::Dx12>() }) else {
                return false;
            };
            unsafe { native.raw_adapter().GetDesc1() }.is_ok_and(|description| {
                description.AdapterLuid.LowPart == expected.low
                    && description.AdapterLuid.HighPart == expected.high
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (adapter, expected);
            false
        }
    }
}
