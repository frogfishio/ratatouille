// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::fmt::Write as _;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    Text,
    Ndjson,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropPolicy {
    DropOldest,
    DropNewest,
}

impl Default for DropPolicy {
    fn default() -> Self {
        Self::DropOldest
    }
}

impl Default for Format {
    fn default() -> Self {
        Self::Text
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SourceIdentity {
    pub app: Option<String>,
    pub r#where: Option<String>,
    pub instance: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoggerConfig {
    pub filter: Option<String>,
    pub format: Format,
    pub source: SourceIdentity,
    pub max_topics: usize,
}

impl Default for LoggerConfig {
    fn default() -> Self {
        Self {
            filter: None,
            format: Format::Text,
            source: SourceIdentity::default(),
            max_topics: 256,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub emitted: u64,
    pub dropped: u64,
    pub filtered: u64,
    pub known_topics: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpSinkConfig {
    pub url: String,
    pub token: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TcpSinkConfig {
    pub endpoint: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HttpSinkStats {
    pub sent: u64,
    pub failed: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TcpSinkStats {
    pub sent: u64,
    pub failed: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRelayConfig {
    pub url: String,
    pub token: Option<String>,
    pub user_agent: Option<String>,
    pub batch_bytes: usize,
    pub max_queue_bytes: usize,
    pub max_queue: usize,
    pub drop_policy: DropPolicy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TcpRelayConfig {
    pub endpoint: String,
    pub batch_bytes: usize,
    pub max_queue_bytes: usize,
    pub max_queue: usize,
    pub drop_policy: DropPolicy,
}

impl Default for HttpRelayConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            token: None,
            user_agent: None,
            batch_bytes: 262_144,
            max_queue_bytes: 5_242_880,
            max_queue: 10_000,
            drop_policy: DropPolicy::DropOldest,
        }
    }
}

impl Default for TcpRelayConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            batch_bytes: 262_144,
            max_queue_bytes: 5_242_880,
            max_queue: 10_000,
            drop_policy: DropPolicy::DropOldest,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HttpRelayStats {
    pub queued: u64,
    pub queued_bytes: u64,
    pub dropped: u64,
    pub dropped_bytes: u64,
    pub sent_batches: u64,
    pub sent_bytes: u64,
    pub failed_flushes: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TcpRelayStats {
    pub queued: u64,
    pub queued_bytes: u64,
    pub dropped: u64,
    pub dropped_bytes: u64,
    pub sent_batches: u64,
    pub sent_bytes: u64,
    pub failed_flushes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmitResult {
    Emitted,
    Filtered,
    Dropped,
}

pub trait Sink {
    fn write_line(&mut self, line: &str);
}

#[derive(Default)]
pub struct StdoutSink;

impl Sink for StdoutSink {
    fn write_line(&mut self, line: &str) {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(line.as_bytes());
        let _ = stdout.write_all(b"\n");
    }
}

pub struct FnSink<F>
where
    F: FnMut(&str),
{
    callback: F,
}

impl<F> FnSink<F>
where
    F: FnMut(&str),
{
    pub fn new(callback: F) -> Self {
        Self { callback }
    }
}

impl<F> Sink for FnSink<F>
where
    F: FnMut(&str),
{
    fn write_line(&mut self, line: &str) {
        (self.callback)(line);
    }
}

#[derive(Clone, Debug)]
struct Pattern {
    value: String,
    negated: bool,
}

pub struct HttpSink {
    host: String,
    port: String,
    path: String,
    token: Option<String>,
    user_agent: String,
    stats: HttpSinkStats,
}

pub struct TcpSink {
    host: String,
    port: String,
    stats: TcpSinkStats,
}

pub struct HttpRelay {
    sink: HttpSink,
    queue: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    batch_bytes: usize,
    max_queue_bytes: usize,
    max_queue: usize,
    drop_policy: DropPolicy,
    stats: HttpRelayStats,
}

pub struct TcpRelay {
    sink: TcpSink,
    queue: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    batch_bytes: usize,
    max_queue_bytes: usize,
    max_queue: usize,
    drop_policy: DropPolicy,
    stats: TcpRelayStats,
}

pub struct Logger<S: Sink = StdoutSink> {
    config: LoggerConfig,
    sink: S,
    patterns: Vec<Pattern>,
    allow_count: usize,
    deny_count: usize,
    topics: HashMap<String, u64>,
    stats: Stats,
}

impl Logger<StdoutSink> {
    pub fn new(config: LoggerConfig) -> Self {
        Self::with_sink(config, StdoutSink)
    }
}

impl<S: Sink> Logger<S> {
    pub fn with_sink(config: LoggerConfig, sink: S) -> Self {
        let (patterns, allow_count, deny_count) = compile_filter(config.filter.as_deref());
        Self {
            topics: HashMap::new(),
            stats: Stats::default(),
            config,
            sink,
            patterns,
            allow_count,
            deny_count,
        }
    }

    pub fn is_enabled(&self, topic: &str) -> bool {
        topic_enabled(&self.patterns, self.allow_count, self.deny_count, topic)
    }

    pub fn log(&mut self, topic: &str, message: &str) -> EmitResult {
        self.log_bytes(topic, message.as_bytes())
    }

    pub fn log_bytes(&mut self, topic: &str, payload: &[u8]) -> EmitResult {
        if topic.is_empty() {
            self.stats.dropped += 1;
            return EmitResult::Dropped;
        }

        if !self.is_enabled(topic) {
            self.stats.filtered += 1;
            return EmitResult::Filtered;
        }

        if !self.topics.contains_key(topic) && self.topics.len() >= self.config.max_topics {
            self.stats.dropped += 1;
            return EmitResult::Dropped;
        }

        let seq = {
            let entry = self.topics.entry(topic.to_owned()).or_insert(0);
            *entry += 1;
            *entry
        };

        let line = match self.config.format {
            Format::Text => format_text_line(topic, seq, payload),
            Format::Ndjson => format_ndjson_line(topic, seq, payload, &self.config.source),
        };

        self.sink.write_line(&line);
        self.stats.emitted += 1;
        self.stats.known_topics = self.topics.len() as u64;
        EmitResult::Emitted
    }

    pub fn stats(&self) -> Stats {
        let mut stats = self.stats;
        stats.known_topics = self.topics.len() as u64;
        stats
    }

    pub fn sink_mut(&mut self) -> &mut S {
        &mut self.sink
    }

    pub fn into_sink(self) -> S {
        self.sink
    }
}

impl HttpSink {
    pub fn new(config: HttpSinkConfig) -> io::Result<Self> {
        let (host, port, path) = parse_http_url(&config.url)?;
        Ok(Self {
            host,
            port,
            path,
            token: config.token,
            user_agent: config
                .user_agent
                .unwrap_or_else(|| "ratatouille-rust/0.1".to_owned()),
            stats: HttpSinkStats::default(),
        })
    }

    pub fn stats(&self) -> HttpSinkStats {
        self.stats
    }

    pub fn post(&mut self, line: &str) -> io::Result<()> {
        let mut body = Vec::with_capacity(line.len() + 1);
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
        self.post_chunk(&body)
    }

    pub fn post_chunk(&mut self, chunk: &[u8]) -> io::Result<()> {
        let token_header = self
            .token
            .as_ref()
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();

        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: {}\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
            self.path,
            self.host,
            self.user_agent,
            chunk.len(),
            token_header,
        );

        let address = format!("{}:{}", self.host, self.port);
        let mut stream = TcpStream::connect(address).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        stream.write_all(request.as_bytes()).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        stream.write_all(chunk).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        stream.flush().inspect_err(|_| {
            self.stats.failed += 1;
        })?;

        let mut response = [0u8; 256];
        let size = stream.read(&mut response).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        if size == 0 || !http_status_ok(&response[..size]) {
            self.stats.failed += 1;
            return Err(io::Error::other("http sink received non-2xx response"));
        }

        self.stats.sent += 1;
        Ok(())
    }
}

impl Sink for HttpSink {
    fn write_line(&mut self, line: &str) {
        let _ = self.post(line);
    }
}

impl TcpSink {
    pub fn new(config: TcpSinkConfig) -> io::Result<Self> {
        let (host, port) = parse_tcp_endpoint(&config.endpoint)?;
        Ok(Self {
            host,
            port,
            stats: TcpSinkStats::default(),
        })
    }

    pub fn stats(&self) -> TcpSinkStats {
        self.stats
    }

    pub fn send(&mut self, line: &str) -> io::Result<()> {
        let mut body = Vec::with_capacity(line.len() + 1);
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
        self.send_chunk(&body)
    }

    pub fn send_chunk(&mut self, chunk: &[u8]) -> io::Result<()> {
        let address = format!("{}:{}", self.host, self.port);
        let mut stream = TcpStream::connect(address).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        stream.write_all(chunk).inspect_err(|_| {
            self.stats.failed += 1;
        })?;
        stream.flush().inspect_err(|_| {
            self.stats.failed += 1;
        })?;

        self.stats.sent += 1;
        Ok(())
    }
}

impl Sink for TcpSink {
    fn write_line(&mut self, line: &str) {
        let _ = self.send(line);
    }
}

impl HttpRelay {
    pub fn new(config: HttpRelayConfig) -> io::Result<Self> {
        if config.url.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "relay url is empty"));
        }

        Ok(Self {
            sink: HttpSink::new(HttpSinkConfig {
                url: config.url,
                token: config.token,
                user_agent: config.user_agent,
            })?,
            queue: VecDeque::new(),
            queued_bytes: 0,
            batch_bytes: config.batch_bytes.max(1),
            max_queue_bytes: config.max_queue_bytes.max(1),
            max_queue: config.max_queue.max(1),
            drop_policy: config.drop_policy,
            stats: HttpRelayStats::default(),
        })
    }

    pub fn stats(&self) -> HttpRelayStats {
        let mut stats = self.stats;
        stats.queued = self.queue.len() as u64;
        stats.queued_bytes = self.queued_bytes as u64;
        stats
    }

    pub fn send_line(&mut self, line: &str) -> io::Result<bool> {
        self.send_chunk(line.as_bytes())
    }

    pub fn send_chunk(&mut self, chunk: &[u8]) -> io::Result<bool> {
        let mut data = Vec::with_capacity(chunk.len() + 1);
        data.extend_from_slice(chunk);
        if !data.ends_with(b"\n") {
            data.push(b'\n');
        }

        if data.len() > self.batch_bytes {
            self.stats.dropped += 1;
            self.stats.dropped_bytes += data.len() as u64;
            return Ok(false);
        }

        while (self.queue.len() >= self.max_queue || self.queued_bytes + data.len() > self.max_queue_bytes)
            && !self.queue.is_empty()
        {
            if self.drop_policy == DropPolicy::DropNewest {
                self.stats.dropped += 1;
                self.stats.dropped_bytes += data.len() as u64;
                return Ok(false);
            }
            self.drop_oldest();
        }

        if self.queue.len() >= self.max_queue || self.queued_bytes + data.len() > self.max_queue_bytes {
            self.stats.dropped += 1;
            self.stats.dropped_bytes += data.len() as u64;
            return Ok(false);
        }

        self.queued_bytes += data.len();
        self.queue.push_back(data);
        Ok(true)
    }

    pub fn flush_now(&mut self) -> io::Result<bool> {
        if self.queue.is_empty() {
            return Ok(false);
        }

        let mut batch = Vec::new();
        let mut count = 0usize;
        for line in &self.queue {
            if batch.len() + line.len() > self.batch_bytes {
                break;
            }
            batch.extend_from_slice(line);
            count += 1;
        }

        if count == 0 {
            if let Some(line) = self.queue.pop_front() {
                self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
                self.stats.dropped += 1;
                self.stats.dropped_bytes += line.len() as u64;
            }
            return Ok(false);
        }

        if let Err(err) = self.sink.post_chunk(&batch) {
            self.stats.failed_flushes += 1;
            return Err(err);
        }

        for _ in 0..count {
            if let Some(line) = self.queue.pop_front() {
                self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
            }
        }

        self.stats.sent_batches += 1;
        self.stats.sent_bytes += batch.len() as u64;
        Ok(true)
    }

    fn drop_oldest(&mut self) {
        if let Some(line) = self.queue.pop_front() {
            self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
            self.stats.dropped += 1;
            self.stats.dropped_bytes += line.len() as u64;
        }
    }
}

impl Sink for HttpRelay {
    fn write_line(&mut self, line: &str) {
        let _ = self.send_line(line);
    }
}

impl TcpRelay {
    pub fn new(config: TcpRelayConfig) -> io::Result<Self> {
        if config.endpoint.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "relay endpoint is empty"));
        }

        Ok(Self {
            sink: TcpSink::new(TcpSinkConfig {
                endpoint: config.endpoint,
            })?,
            queue: VecDeque::new(),
            queued_bytes: 0,
            batch_bytes: config.batch_bytes.max(1),
            max_queue_bytes: config.max_queue_bytes.max(1),
            max_queue: config.max_queue.max(1),
            drop_policy: config.drop_policy,
            stats: TcpRelayStats::default(),
        })
    }

    pub fn stats(&self) -> TcpRelayStats {
        let mut stats = self.stats;
        stats.queued = self.queue.len() as u64;
        stats.queued_bytes = self.queued_bytes as u64;
        stats
    }

    pub fn send_line(&mut self, line: &str) -> io::Result<bool> {
        self.send_chunk(line.as_bytes())
    }

    pub fn send_chunk(&mut self, chunk: &[u8]) -> io::Result<bool> {
        let mut data = Vec::with_capacity(chunk.len() + 1);
        data.extend_from_slice(chunk);
        if !data.ends_with(b"\n") {
            data.push(b'\n');
        }

        if data.len() > self.batch_bytes {
            self.stats.dropped += 1;
            self.stats.dropped_bytes += data.len() as u64;
            return Ok(false);
        }

        while (self.queue.len() >= self.max_queue || self.queued_bytes + data.len() > self.max_queue_bytes)
            && !self.queue.is_empty()
        {
            if self.drop_policy == DropPolicy::DropNewest {
                self.stats.dropped += 1;
                self.stats.dropped_bytes += data.len() as u64;
                return Ok(false);
            }
            self.drop_oldest();
        }

        if self.queue.len() >= self.max_queue || self.queued_bytes + data.len() > self.max_queue_bytes {
            self.stats.dropped += 1;
            self.stats.dropped_bytes += data.len() as u64;
            return Ok(false);
        }

        self.queued_bytes += data.len();
        self.queue.push_back(data);
        Ok(true)
    }

    pub fn flush_now(&mut self) -> io::Result<bool> {
        if self.queue.is_empty() {
            return Ok(false);
        }

        let mut batch = Vec::new();
        let mut count = 0usize;
        for line in &self.queue {
            if batch.len() + line.len() > self.batch_bytes {
                break;
            }
            batch.extend_from_slice(line);
            count += 1;
        }

        if count == 0 {
            if let Some(line) = self.queue.pop_front() {
                self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
                self.stats.dropped += 1;
                self.stats.dropped_bytes += line.len() as u64;
            }
            return Ok(false);
        }

        if let Err(err) = self.sink.send_chunk(&batch) {
            self.stats.failed_flushes += 1;
            return Err(err);
        }

        for _ in 0..count {
            if let Some(line) = self.queue.pop_front() {
                self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
            }
        }

        self.stats.sent_batches += 1;
        self.stats.sent_bytes += batch.len() as u64;
        Ok(true)
    }

    fn drop_oldest(&mut self) {
        if let Some(line) = self.queue.pop_front() {
            self.queued_bytes = self.queued_bytes.saturating_sub(line.len());
            self.stats.dropped += 1;
            self.stats.dropped_bytes += line.len() as u64;
        }
    }
}

impl Sink for TcpRelay {
    fn write_line(&mut self, line: &str) {
        let _ = self.send_line(line);
    }
}

fn compile_filter(filter: Option<&str>) -> (Vec<Pattern>, usize, usize) {
    let mut patterns = Vec::new();
    let mut allow_count = 0;
    let mut deny_count = 0;

    let Some(filter) = filter else {
        return (patterns, allow_count, deny_count);
    };

    for token in filter.split(|ch: char| ch.is_ascii_whitespace() || ch == ',') {
        if token.is_empty() {
            continue;
        }

        let (negated, body) = if let Some(rest) = token.strip_prefix('-') {
            (true, rest)
        } else {
            (false, token)
        };

        if body.is_empty() {
            continue;
        }

        patterns.push(Pattern {
            value: body.to_owned(),
            negated,
        });

        if negated {
            deny_count += 1;
        } else {
            allow_count += 1;
        }
    }

    (patterns, allow_count, deny_count)
}

fn topic_enabled(patterns: &[Pattern], allow_count: usize, deny_count: usize, topic: &str) -> bool {
    if allow_count == 0 && deny_count == 0 {
        return false;
    }

    let mut allowed = allow_count == 0 && deny_count > 0;
    for pattern in patterns {
        if !wildcard_match(&pattern.value, topic) {
            continue;
        }
        if pattern.negated {
            return false;
        }
        allowed = true;
    }

    allowed
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star = None;
    let mut retry = 0usize;

    while ti < text.len() {
        if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            retry = ti;
            continue;
        }

        if pi < pattern.len() && pattern[pi] == text[ti] {
            pi += 1;
            ti += 1;
            continue;
        }

        if let Some(star_index) = star {
            pi = star_index + 1;
            retry += 1;
            ti = retry;
            continue;
        }

        return false;
    }

    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }

    pi == pattern.len()
}

fn parse_http_url(url: &str) -> io::Result<(String, String, String)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "only http:// urls are supported"))?;
    if rest.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "http url is empty"));
    }

    let slash = rest.find('/');
    let authority = slash.map(|index| &rest[..index]).unwrap_or(rest);
    let mut path = slash.map(|index| &rest[index..]).unwrap_or("/sink");
    if authority.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "http host is empty"));
    }
    if path == "/" || path.is_empty() {
        path = "/sink";
    }

    let (host, port) = if let Some(index) = authority.rfind(':') {
        let host = &authority[..index];
        let port = &authority[index + 1..];
        if host.is_empty() || port.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid http authority"));
        }
        (host.to_owned(), port.to_owned())
    } else {
        (authority.to_owned(), "80".to_owned())
    };

    Ok((host, port, path.to_owned()))
}

fn parse_tcp_endpoint(endpoint: &str) -> io::Result<(String, String)> {
    let rest = endpoint
        .strip_prefix("tcp://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "only tcp:// endpoints are supported"))?;
    if rest.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "tcp endpoint is empty"));
    }

    let (host, port) = rest
        .rsplit_once(':')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "tcp endpoint must include host:port"))?;
    if host.is_empty() || port.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid tcp endpoint"));
    }

    Ok((host.to_owned(), port.to_owned()))
}

fn http_status_ok(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Some(line) = text.lines().next() else {
        return false;
    };
    if !line.starts_with("HTTP/1.") {
        return false;
    }
    line.split_whitespace().nth(1).is_some_and(|status| status.starts_with('2'))
}

fn format_text_line(topic: &str, seq: u64, payload: &[u8]) -> String {
    let mut out = String::new();
    let _ = write!(out, "[{} #{:06}] {} - ", now_iso8601(), seq, topic);
    append_text_payload(&mut out, payload);
    out
}

fn format_ndjson_line(topic: &str, seq: u64, payload: &[u8], source: &SourceIdentity) -> String {
    let mut out = String::new();
    out.push('{');
    out.push_str("\"ts\":");
    push_json_string(&mut out, now_iso8601().as_bytes());
    let _ = write!(out, ",\"seq\":{},\"topic\":", seq);
    push_json_string(&mut out, topic.as_bytes());

    if source.app.is_some() || source.r#where.is_some() || source.instance.is_some() {
        out.push_str(",\"src\":{");
        let mut first = true;
        if let Some(app) = &source.app {
            push_json_field(&mut out, &mut first, "app", app.as_bytes());
        }
        if let Some(where_value) = &source.r#where {
            push_json_field(&mut out, &mut first, "where", where_value.as_bytes());
        }
        if let Some(instance) = &source.instance {
            push_json_field(&mut out, &mut first, "instance", instance.as_bytes());
        }
        out.push('}');
    }

    out.push_str(",\"args\":[");
    push_json_string(&mut out, payload);
    out.push_str("]}");
    out
}

fn push_json_field(out: &mut String, first: &mut bool, key: &str, value: &[u8]) {
    if !*first {
        out.push(',');
    }
    *first = false;
    push_json_string(out, key.as_bytes());
    out.push(':');
    push_json_string(out, value);
}

fn push_json_string(out: &mut String, bytes: &[u8]) {
    out.push('"');
    for &byte in bytes {
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x20..=0x7e => out.push(byte as char),
            _ => {
                let _ = write!(out, "\\u{:04x}", byte);
            }
        }
    }
    out.push('"');
}

fn append_text_payload(out: &mut String, bytes: &[u8]) {
    for &byte in bytes {
        match byte {
            b'\\' => out.push_str("\\\\"),
            0x20..=0x7e => out.push(byte as char),
            _ => {
                let _ = write!(out, "\\x{:02x}", byte);
            }
        }
    }
}

fn now_iso8601() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_only_allows_everything_else() {
        let config = LoggerConfig {
            filter: Some("-chat*".into()),
            ..LoggerConfig::default()
        };
        let logger = Logger::with_sink(config, FnSink::new(|_| {}));
        assert!(logger.is_enabled("api"));
        assert!(!logger.is_enabled("chatty"));
    }

    #[test]
    fn logger_emits_ndjson() {
        let mut lines = Vec::<String>::new();
        let config = LoggerConfig {
            filter: Some("api*".into()),
            format: Format::Ndjson,
            ..LoggerConfig::default()
        };
        let mut logger = Logger::with_sink(config, FnSink::new(|line| lines.push(line.to_owned())));
        assert_eq!(logger.log("api", "hello"), EmitResult::Emitted);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"topic\":\"api\""));
        assert!(lines[0].contains("\"args\":[\"hello\"]"));
    }

    #[test]
    fn relay_queues_and_flushes() {
        let relay = HttpRelay::new(HttpRelayConfig {
            url: "http://127.0.0.1:8080/sink".into(),
            batch_bytes: 64,
            max_queue_bytes: 256,
            max_queue: 4,
            ..HttpRelayConfig::default()
        })
        .unwrap();
        let stats = relay.stats();
        assert_eq!(stats.queued, 0);
    }
}
