// MSVC's localized "creating import library" note is informational but Rust 1.97 classifies the
// unrecognized localized linker line under this lint.
#![allow(linker_messages)]

fn main() {
    use clap::Parser;
    if let Err(error) = aster_desktop_bridge::BridgeLogging::init() {
        eprintln!("Aster desktop bridge logging failed: {error}");
    }
    if let Err(error) = aster_desktop_bridge::BridgeOptions::parse().run() {
        tracing::error!(event = "bridge_fatal", error = %error, "desktop bridge failed");
        std::process::exit(1);
    }
}
