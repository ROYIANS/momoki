// Regression uses actual reqwest body + Tauri ResourceTable, not a mocked future.
use super::*;
use std::io::{Read, Write};

fn stalled_response() -> (String, std::sync::mpsc::Receiver<bool>, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/stalled-body", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = [0; 4096]; socket.read(&mut request).unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nfirst\r\n").unwrap();
        socket.flush().unwrap();
        let disconnected = matches!(socket.read(&mut request), Ok(0));
        tx.send(disconnected).unwrap();
    });
    (url, rx, server)
}

#[test]
fn pending_body_resource_close_interrupts_stalled_read_and_disconnects() {
    tauri::async_runtime::block_on(async {
        let (url, disconnected, server) = stalled_response();
        let mut response = reqwest::Client::builder().no_proxy().build().unwrap().get(url).send().await.unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"first");
        let mut table = ResourceTable::default();
        let rid = table.add(ReqwestResponse::new(response));
        let resource = table.get::<ReqwestResponse>(rid).unwrap();
        let (ready_tx, ready_rx) = channel();
        let task = tauri::async_runtime::spawn(async move {
            let _ = ready_tx.send(());
            resource.read_chunk().await
        });
        ready_rx.await.unwrap();
        std::thread::sleep(Duration::from_millis(30));
        table.close(rid).unwrap();
        assert!(matches!(task.await.unwrap(), Err(Error::RequestCanceled)));
        assert!(disconnected.recv_timeout(Duration::from_secs(2)).unwrap());
        server.join().unwrap();
    });
}

#[test]
fn null_body_statuses_release_native_resources_without_affecting_streamed_responses() {
    tauri::async_runtime::block_on(async {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/null-body", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for status in [200, 204, 205, 304].into_iter().cycle().take(40) {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).unwrap();
                let body = if status == 200 { "kept" } else { "" };
                write!(socket, "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                socket.flush().unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut table = ResourceTable::default();
        for _ in 0..10 {
            let response = client.get(&url).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let kept = register_response(&mut table, response);
            assert!(table.has(kept));
            for status in [204, 205, 304] {
                let response = client.get(&url).send().await.unwrap();
                assert_eq!(response.status().as_u16(), status);
                let rid = register_response(&mut table, response);
                assert!(!table.has(rid), "null status {status} leaked a native resource");
                assert!(table.has(kept), "null-body cleanup closed an unrelated response");
            }
            let response = table.get::<ReqwestResponse>(kept).unwrap();
            assert_eq!(response.read_chunk().await.unwrap().unwrap(), b"kept");
            assert!(response.read_chunk().await.unwrap().is_none());
            table.close(kept).unwrap();
        }
        server.join().unwrap();
        for status in [101, 103, 204, 205, 304] { assert!(js_null_body(StatusCode::from_u16(status).unwrap())); }
        for status in [200, 201, 202, 206, 301, 400, 500] { assert!(!js_null_body(StatusCode::from_u16(status).unwrap())); }
    });
}
