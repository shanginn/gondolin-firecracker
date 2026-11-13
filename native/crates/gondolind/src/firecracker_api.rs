//! Private Firecracker API used for same-host, idle VM-state snapshots.

use gondolin_wire::Value;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Bounded request with a fresh connection (no response can poison a later call)
pub async fn request(socket: &Path, method: &str, route: &str, body: &Value) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut stream = UnixStream::connect(socket).await.map_err(|e| e.to_string())?;
        let body = gondolin_wire::json::to_string(body);
        let headers = format!("{method} {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(headers.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut response = Vec::new();
        // micro_http may keep connections alive: finish at Content-Length, not EOF.
        loop {
            if let Some(end) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&response[..end]);
                let length = head.lines().skip(1).find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>())
                }).transpose().map_err(|_| "invalid Firecracker Content-Length")?.unwrap_or(0);
                if length > 65536 - end - 4 { return Err("Firecracker API response too large".into()); }
                if response.len() >= end + 4 + length { break; }
            }
            if response.len() >= 65536 { return Err("Firecracker API response too large".into()); }
            let mut chunk = [0; 4096];
            let remaining = (65536 - response.len()).min(chunk.len());
            let n = stream.read(&mut chunk[..remaining]).await.map_err(|e| e.to_string())?;
            if n == 0 { return Err("truncated Firecracker API response".into()); }
            response.extend_from_slice(&chunk[..n]);
        }
        let response = String::from_utf8_lossy(&response);
        let status = response.lines().next().unwrap_or_default();
        let code = status.split_whitespace().nth(1).and_then(|v| v.parse::<u16>().ok());
        if code.is_some_and(|c| (200..300).contains(&c)) { Ok(()) }
        else { Err(format!("Firecracker {method} {route}: {response}")) }
    }).await.map_err(|_| format!("Firecracker {method} {route} timed out"))?
}

pub fn object(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (Value::from(k), v)).collect())
}

pub async fn wait_ready(socket: &Path) -> Result<(), String> {
    for _ in 0..500 {
        if socket.exists() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Err("Firecracker API socket did not appear within 5 seconds".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_keepalive_and_reports_api_errors() {
        for (status, body, ok) in [(204, "", true), (400, "paused required", false)] {
            let dir = std::path::PathBuf::from(format!(
                "/tmp/gondolin-fc-api-{}-{status}",
                std::process::id()
            ));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("api.sock");
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                request(&path, "PATCH", "/vm", &object([])),
            )
            .await
            .unwrap();
            assert_eq!(result.is_ok(), ok);
            if !ok {
                assert!(result.unwrap_err().contains(body));
            }
            server.abort();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_missing_api() {
        assert!(
            request(Path::new("/does-not-exist/gondolin.sock"), "PATCH", "/vm", &object([]))
                .await
                .is_err()
        );
    }
}
