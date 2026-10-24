// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Native-messaging framing: each message is UTF-8 JSON preceded by its
//! length as a 32-bit integer in the machine's byte order.

use std::io::{self, Read, Write};

/// Chrome sends at most 64 MiB to a host.
const MAX_READ: u32 = 64 * 1024 * 1024;
/// Chrome accepts at most 1 MiB from a host.
pub const MAX_WRITE: usize = 1024 * 1024;

/// Reads one frame; None at end of input.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len);
    if len > MAX_READ {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame of {} bytes is too large", len),
        ));
    }
    let mut body = vec![0u8; len as usize];
    input.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one frame. A body over the browser's limit is replaced by an
/// error message so the port stays usable.
pub fn write_frame(output: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let fallback;
    let body = if body.len() > MAX_WRITE {
        fallback = br#"{"event":"error","data":{"code":"internal","message":"message too large for the browser"}}"#.to_vec();
        &fallback[..]
    } else {
        body
    };
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(body)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{\"a\":1}").unwrap();
        write_frame(&mut buf, b"{}").unwrap();
        let mut cursor = io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), b"{}");
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn oversized_frames_are_refused_or_replaced() {
        let mut huge = Vec::new();
        huge.extend_from_slice(&(MAX_READ + 1).to_ne_bytes());
        assert!(read_frame(&mut io::Cursor::new(huge)).is_err());
        let mut buf = Vec::new();
        write_frame(&mut buf, &vec![b'x'; MAX_WRITE + 1]).unwrap();
        let mut cursor = io::Cursor::new(buf);
        let body = read_frame(&mut cursor).unwrap().unwrap();
        assert!(std::str::from_utf8(&body).unwrap().contains("too large"));
    }
}
