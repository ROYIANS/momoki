//! Read-only application-local byte transport, using no external service.
use super::*;
use crate::contracts::CHUNK;
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::atomic::AtomicUsize,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CONNECTIONS: usize = 8;
const HEADER_BYTES: usize = 8192;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5);
struct State {
    alive: AtomicBool,
    connections: AtomicUsize,
    previews: Arc<MediaPreviews>,
    validate: ValidateSession,
    origin: String,
    authority: String,
}
pub struct MediaServer {
    state: Arc<State>,
    address: SocketAddr,
    listener: Option<JoinHandle<()>>,
}
impl MediaServer {
    pub fn start(
        previews: Arc<MediaPreviews>,
        origin: String,
        validate: ValidateSession,
    ) -> Result<Self> {
        if !matches!(
            origin.as_str(),
            "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
        ) {
            return Err(Error::new(
                "caller",
                "Media transport requires the bundled application origin",
            ));
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let state = Arc::new(State {
            alive: AtomicBool::new(true),
            connections: AtomicUsize::new(0),
            previews,
            validate,
            origin,
            authority: address.to_string(),
        });
        let running = Arc::clone(&state);
        let listener = thread::Builder::new()
            .name("momoki-media-local".into())
            .spawn(move || {
                while running.alive.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, peer)) => {
                            // Accepted sockets inherit nonblocking mode on macOS.
                            // Explicit blocking mode is required for bounded writes
                            // to apply backpressure instead of truncating on EAGAIN.
                            if stream.set_nonblocking(false).is_err()
                                || stream.set_read_timeout(Some(IDLE_TIMEOUT)).is_err()
                                || stream.set_write_timeout(Some(IDLE_TIMEOUT)).is_err()
                            {
                                continue;
                            }
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            if running
                                .connections
                                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                    (n < CONNECTIONS).then_some(n + 1)
                                })
                                .is_err()
                            {
                                let _ = error_response(&mut stream, 503);
                                continue;
                            }
                            let connection = Connection(Arc::clone(&running));
                            let _ = thread::Builder::new()
                                .name("momoki-media-read".into())
                                .spawn(move || {
                                    let result = serve(&mut stream, &connection.0);
                                    #[cfg(test)]
                                    if let Err(error) = &result {
                                        eprintln!(
                                            "media transport test boundary: {} {}",
                                            error.code, error.message
                                        );
                                    }
                                    let _ = result;
                                });
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::park_timeout(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self {
            state,
            address,
            listener: Some(listener),
        })
    }
    pub fn url(&self, id: &str) -> Result<String> {
        canonical_id(id)?;
        if !self.state.alive.load(Ordering::SeqCst) {
            return Err(Error::new("closed", "Media transport stopped"));
        }
        Ok(format!("http://{}/{id}", self.address))
    }
    pub fn stop(&mut self) {
        self.state.alive.store(false, Ordering::SeqCst);
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
    #[cfg(test)]
    pub(super) fn active_connections(&self) -> usize {
        self.state.connections.load(Ordering::SeqCst)
    }
}
impl Drop for MediaServer {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Connection(Arc<State>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Request {
    id: String,
    range: Option<String>,
    if_range: Option<String>,
    head: bool,
    cors: bool,
}
fn request(stream: &mut TcpStream, state: &State) -> std::result::Result<Request, u16> {
    let started = Instant::now();
    let mut input = Vec::new();
    let mut buffer = [0u8; 1024];
    while !input.windows(4).any(|s| s == b"\r\n\r\n") {
        if started.elapsed() > IDLE_TIMEOUT
            || input.len() >= HEADER_BYTES
            || !state.alive.load(Ordering::SeqCst)
        {
            return Err(400);
        }
        let n = stream.read(&mut buffer).map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        input.extend_from_slice(&buffer[..n]);
    }
    let end = input
        .windows(4)
        .position(|s| s == b"\r\n\r\n")
        .ok_or(400u16)?
        + 4;
    if end != input.len() || end > HEADER_BYTES {
        return Err(400);
    }
    let text = std::str::from_utf8(&input).map_err(|_| 400u16)?;
    let mut lines = text[..end - 4].split("\r\n");
    let mut first = lines.next().ok_or(400u16)?.split(' ');
    let method = first.next().ok_or(400u16)?;
    if method != "GET" && method != "HEAD" {
        return Err(405);
    }
    let target = first.next().ok_or(400u16)?;
    if target.len() != 37 || !target.starts_with('/') || canonical_id(&target[1..]).is_err() {
        return Err(400);
    }
    if !matches!(first.next(), Some("HTTP/1.1" | "HTTP/1.0")) || first.next().is_some() {
        return Err(400);
    }
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(400);
        }
        let value = value.trim();
        if value.bytes().any(|b| b.is_ascii_control())
            || headers.insert(name.to_ascii_lowercase(), value).is_some()
        {
            return Err(400);
        }
    }
    if headers.get("host").copied() != Some(state.authority.as_str()) {
        return Err(403);
    }
    if headers.contains_key("transfer-encoding")
        || headers.get("content-length").is_some_and(|v| *v != "0")
        || headers.contains_key("authorization")
        || headers.contains_key("cookie")
    {
        return Err(400);
    }
    let cors = match headers.get("origin") {
        None => false,
        Some(value) if **value == state.origin => true,
        Some(_) => return Err(403),
    };
    if let Some(referer) = headers.get("referer")
        && !referer
            .strip_prefix(&state.origin)
            .is_some_and(|suffix| suffix.starts_with('/'))
    {
        return Err(403);
    }
    Ok(Request {
        id: target[1..].into(),
        range: if method == "HEAD" {
            None
        } else {
            headers.get("range").map(|v| (*v).to_owned())
        },
        if_range: headers.get("if-range").map(|value| (*value).to_owned()),
        head: method == "HEAD",
        cors,
    })
}
fn error_response(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    // A rejected oversized/body-bearing request can still have unread bytes.
    // Drain only an explicitly bounded turn so closing does not replace our
    // error response with a TCP reset. Never interpret or execute these bytes.
    stream.set_read_timeout(Some(Duration::from_millis(20)))?;
    let started = Instant::now();
    let mut discarded = 0;
    let mut buffer = [0u8; 1024];
    while discarded < HEADER_BYTES && started.elapsed() < Duration::from_millis(100) {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => discarded += n,
        }
    }
    write!(
        stream,
        "HTTP/1.1 {status} Error\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n"
    )?;
    stream.shutdown(std::net::Shutdown::Write)
}
fn serve(stream: &mut TcpStream, state: &State) -> Result<()> {
    let request = match request(stream, state) {
        Ok(request) => request,
        Err(status) => {
            error_response(stream, status)?;
            return Ok(());
        }
    };
    let mut read = match state.previews.open(&request.id, &state.validate) {
        Ok(read) => read,
        Err(_) => {
            error_response(stream, 410)?;
            return Ok(());
        }
    };
    let reference = read.file.reference().clone();
    let etag = format!("\"sha256:{}\"", reference.content_hash);
    // A conditional range may only select a partial response if its strong
    // validator matches this immutable capability's verified representation.
    let range = if request
        .if_range
        .as_deref()
        .is_some_and(|value| value != etag)
    {
        None
    } else {
        request.range.as_deref()
    };
    let selected = match select_range(range, reference.byte_length) {
        Ok(selected) => selected,
        Err(_) => {
            write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\n\r\n",
                reference.byte_length
            )?;
            return Ok(());
        }
    };
    // EOF reads validate identity for HEAD without reading representation bytes.
    let initial = read.read(
        if request.head {
            reference.byte_length
        } else {
            selected.start
        },
        if request.head {
            1
        } else {
            ((selected.end - selected.start).min(CHUNK as u64) as usize).max(1)
        },
        &state.validate,
    );
    let mut bytes = match initial {
        Ok(bytes) => bytes,
        Err(_) => {
            error_response(stream, 410)?;
            return Ok(());
        }
    };
    if !state.alive.load(Ordering::SeqCst) {
        return Err(Error::new("closed", "Media transport stopped"));
    }
    let status = if selected.partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\nAccept-Ranges: bytes\r\nX-Content-Type-Options: nosniff\r\nContent-Type: {}\r\nContent-Length: {}\r\n",
        reference.mime_type,
        selected.end - selected.start
    )?;
    if selected.partial {
        write!(
            stream,
            "Content-Range: bytes {}-{}/{}\r\n",
            selected.start,
            selected.end - 1,
            reference.byte_length
        )?;
    }
    write!(stream, "ETag: {etag}\r\n")?;
    if request.cors {
        write!(
            stream,
            "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n",
            state.origin
        )?;
    }
    stream.write_all(b"\r\n")?;
    if request.head {
        return Ok(());
    }
    let mut offset = selected.start;
    loop {
        if !state.alive.load(Ordering::SeqCst) {
            return Err(Error::new("closed", "Media transport stopped"));
        }
        // Blocking bounded writes provide socket backpressure, without an
        // unbounded queue of future chunks or a whole-file Vec.
        stream.write_all(&bytes)?;
        offset += bytes.len() as u64;
        if offset == selected.end {
            break;
        }
        bytes = read.read(
            offset,
            (selected.end - offset).min(CHUNK as u64) as usize,
            &state.validate,
        )?;
        if bytes.is_empty() {
            return Err(Error::new(
                "changed",
                "Playback ended before declared length",
            ));
        }
    }
    Ok(())
}
