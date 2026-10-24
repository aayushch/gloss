// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Drives the built `gloss-bridge` binary the way a browser does.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn frame(body: &str) -> Vec<u8> {
    let mut v = (body.len() as u32).to_ne_bytes().to_vec();
    v.extend_from_slice(body.as_bytes());
    v
}

fn read_frame(r: &mut impl Read) -> serde_json::Value {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).unwrap();
    let mut body = vec![0u8; u32::from_ne_bytes(len) as usize];
    r.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[test]
fn reports_app_not_running_without_a_socket() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_gloss-bridge"))
        .arg("chrome-extension://abc/")
        .env("GLOSS_HOME", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    stdin
        .write_all(&frame(
            r#"{"id":"1","method":"hello","params":{"protocol":1}}"#,
        ))
        .unwrap();
    let reply = read_frame(&mut stdout);
    assert_eq!(reply["id"], "1");
    assert_eq!(reply["error"]["code"], "app_not_running");
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
