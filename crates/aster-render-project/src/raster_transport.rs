use crate::ProjectRenderError;
use aster_video::CancellationToken;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    time::{Duration, Instant},
};

pub(crate) struct RasterChannel {
    socket: TcpStream,
    maximum_json: usize,
    timeout: Duration,
    deadline: Instant,
}

impl RasterChannel {
    pub fn new(
        socket: TcpStream,
        maximum_json: usize,
        timeout: Duration,
    ) -> Result<Self, ProjectRenderError> {
        socket.set_nodelay(true)?;
        socket.set_read_timeout(Some(Duration::from_millis(50)))?;
        socket.set_write_timeout(Some(Duration::from_millis(50)))?;
        Ok(Self {
            socket,
            maximum_json,
            timeout,
            deadline: Instant::now() + timeout,
        })
    }

    pub fn send(
        &mut self,
        value: &impl Serialize,
        cancel: &CancellationToken,
    ) -> Result<(), ProjectRenderError> {
        self.deadline = Instant::now() + self.timeout;
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > self.maximum_json || bytes.len() > u32::MAX as usize {
            return Err(ProjectRenderError::Invalid(
                "raster control exceeds byte budget".into(),
            ));
        }
        self.write_bytes(&(bytes.len() as u32).to_le_bytes(), cancel)?;
        self.write_bytes(&bytes, cancel)
    }

    pub fn receive<T: DeserializeOwned>(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<T, ProjectRenderError> {
        let prefix = self.read_bytes(4, cancel)?;
        let length = u32::from_le_bytes(
            prefix
                .try_into()
                .map_err(|_| ProjectRenderError::Invalid("raster control length absent".into()))?,
        ) as usize;
        if length == 0 || length > self.maximum_json {
            return Err(ProjectRenderError::Invalid(
                "raster reply exceeds byte budget".into(),
            ));
        }
        Ok(serde_json::from_slice(&self.read_bytes(length, cancel)?)?)
    }

    pub fn read_bytes(
        &mut self,
        length: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, ProjectRenderError> {
        let mut bytes = vec![0; length];
        let mut position = 0;
        while position < length {
            self.check(cancel)?;
            match self.socket.read(&mut bytes[position..]) {
                Ok(0) => {
                    return Err(ProjectRenderError::Invalid(
                        "raster provider disconnected".into(),
                    ));
                }
                Ok(count) => position += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(bytes)
    }

    fn write_bytes(
        &mut self,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<(), ProjectRenderError> {
        let mut position = 0;
        while position < bytes.len() {
            self.check(cancel)?;
            match self.socket.write(&bytes[position..]) {
                Ok(0) => {
                    return Err(ProjectRenderError::Invalid(
                        "raster provider input closed".into(),
                    ));
                }
                Ok(count) => position += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn check(&self, cancel: &CancellationToken) -> Result<(), ProjectRenderError> {
        if cancel.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if Instant::now() >= self.deadline {
            return Err(ProjectRenderError::Invalid(
                "raster provider exchange timed out".into(),
            ));
        }
        Ok(())
    }
}

impl Drop for RasterChannel {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests;
