use aster_renderer::PreviewHandleGuard;
use clap::Args;
use std::process::ExitCode;

#[derive(Debug, Args)]
pub(crate) struct PreviewGuardArgs {
    #[arg(long)]
    producer_pid: u32,
    #[arg(long)]
    consumer_pid: u32,
    #[arg(long)]
    slots: usize,
    #[arg(long)]
    max_control_bytes: usize,
}

impl PreviewGuardArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        PreviewHandleGuard::serve(
            self.producer_pid,
            self.consumer_pid,
            self.slots,
            self.max_control_bytes,
        )?;
        Ok(ExitCode::SUCCESS)
    }
}
