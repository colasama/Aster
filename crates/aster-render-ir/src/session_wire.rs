use std::io::{BufRead, ErrorKind};

use crate::{IrError, SessionRequest};

#[derive(Clone, Debug)]
pub struct SessionWireLimits {
    pub max_control_bytes: usize,
    pub max_payload_bytes: usize,
}

pub struct SessionPacket {
    pub request: SessionRequest,
    pub payload: Vec<u8>,
}

/// A bounded JSON line followed by the declared binary bytes, with no binary delimiter.
pub struct SessionReader<R> {
    input: R,
    limits: SessionWireLimits,
    previous_id: u64,
    failed: bool,
}

impl<R: BufRead> SessionReader<R> {
    pub fn new(input: R, limits: SessionWireLimits) -> Result<Self, IrError> {
        if limits.max_control_bytes == 0
            || limits.max_control_bytes > u32::MAX as usize
            || limits.max_payload_bytes < 32
            || limits.max_payload_bytes > u32::MAX as usize
        {
            return Err(IrError::LimitExceeded("invalid session wire limits".into()));
        }
        Ok(Self {
            input,
            limits,
            previous_id: 0,
            failed: false,
        })
    }

    pub fn read_packet(&mut self) -> Result<Option<SessionPacket>, IrError> {
        if self.failed {
            return Err(IrError::InvalidHeader(
                "session framing already failed".into(),
            ));
        }
        let packet = self.read_bounded();
        if packet.is_err() {
            self.failed = true;
        }
        packet
    }

    fn read_bounded(&mut self) -> Result<Option<SessionPacket>, IrError> {
        let mut control = Vec::new();
        loop {
            let available = self.input.fill_buf()?;
            if available.is_empty() {
                return if control.is_empty() {
                    Ok(None)
                } else {
                    Err(
                        std::io::Error::new(ErrorKind::UnexpectedEof, "truncated session control")
                            .into(),
                    )
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let take = newline.map_or(available.len(), |index| index + 1);
            if take > self.limits.max_control_bytes.saturating_sub(control.len()) {
                return Err(IrError::LimitExceeded("session control line".into()));
            }
            control.extend_from_slice(&available[..take]);
            self.input.consume(take);
            if newline.is_some() {
                break;
            }
        }
        let request: SessionRequest = serde_json::from_slice(&control)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let size = request.payload_bytes(self.limits.max_payload_bytes)?;
        if request.request_id <= self.previous_id {
            return Err(IrError::InvalidHeader(
                "session request IDs must increase".into(),
            ));
        }
        let mut payload = Vec::new();
        payload
            .try_reserve_exact(size)
            .map_err(|_| IrError::LimitExceeded("session allocation".into()))?;
        payload.resize(size, 0);
        self.input.read_exact(&mut payload)?;
        self.previous_id = request.request_id;
        Ok(Some(SessionPacket { request, payload }))
    }
}

#[cfg(test)]
#[path = "session_wire_tests.rs"]
mod tests;
