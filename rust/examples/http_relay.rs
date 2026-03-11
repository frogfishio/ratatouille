// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

use ratatouille::{Format, HttpRelay, HttpRelayConfig, Logger, LoggerConfig, SourceIdentity};

fn main() {
    let relay = HttpRelay::new(HttpRelayConfig {
        url: "http://127.0.0.1:8080/sink".to_owned(),
        user_agent: Some("ratatouille-rust-relay/0.1".to_owned()),
        batch_bytes: 4096,
        max_queue_bytes: 65536,
        max_queue: 128,
        ..HttpRelayConfig::default()
    })
    .expect("failed to create relay");

    let mut config = LoggerConfig::default();
    config.filter = Some("api*".to_owned());
    config.format = Format::Ndjson;
    config.source = SourceIdentity {
        app: Some("example".to_owned()),
        r#where: Some("rust".to_owned()),
        instance: Some("local".to_owned()),
    };

    let mut logger = Logger::with_sink(config, relay);
    let _ = logger.log("api", "queued one");
    let _ = logger.log("api", "queued two");
    let _ = logger.log("api", "queued three");

    let flushed = logger.sink_mut().flush_now().expect("relay flush failed");
    let stats = logger.sink_mut().stats();

    eprintln!(
        "flushed={} queued={} dropped={} sent_batches={} sent_bytes={} failed_flushes={}",
        flushed,
        stats.queued,
        stats.dropped,
        stats.sent_batches,
        stats.sent_bytes,
        stats.failed_flushes
    );
}
