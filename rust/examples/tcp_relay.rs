// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

use ratatouille::{Format, Logger, LoggerConfig, SourceIdentity, TcpRelay, TcpRelayConfig};

fn main() -> std::io::Result<()> {
    let relay = TcpRelay::new(TcpRelayConfig {
        endpoint: "tcp://127.0.0.1:9000".into(),
        batch_bytes: 4096,
        max_queue_bytes: 65_536,
        max_queue: 128,
        ..TcpRelayConfig::default()
    })?;

    let mut config = LoggerConfig::default();
    config.filter = Some("api*".into());
    config.format = Format::Ndjson;
    config.source = SourceIdentity {
        app: Some("example".into()),
        r#where: Some("rust".into()),
        instance: Some("local".into()),
    };

    let mut log = Logger::with_sink(config, relay);
    let _ = log.log("api", "queued one");
    let _ = log.log("api", "queued two");
    let _ = log.log("api", "queued value=3");
    let _ = log.sink_mut().flush_now()?;

    let stats = log.sink_mut().stats();
    eprintln!(
        "queued={} dropped={} sent_batches={} sent_bytes={} failed_flushes={}",
        stats.queued, stats.dropped, stats.sent_batches, stats.sent_bytes, stats.failed_flushes
    );
    Ok(())
}