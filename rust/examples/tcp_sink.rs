// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

use ratatouille::{Format, Logger, LoggerConfig, SourceIdentity, TcpSink, TcpSinkConfig};

fn main() -> std::io::Result<()> {
    let sink = TcpSink::new(TcpSinkConfig {
        endpoint: "tcp://127.0.0.1:9000".into(),
    })?;

    let mut config = LoggerConfig::default();
    config.filter = Some("api*".into());
    config.format = Format::Ndjson;
    config.source = SourceIdentity {
        app: Some("example".into()),
        r#where: Some("rust".into()),
        instance: Some("local".into()),
    };

    let mut log = Logger::with_sink(config, sink);
    let _ = log.log("api", "sent over tcp");
    let _ = log.log("api", "value=42");

    let stats = log.sink_mut().stats();
    eprintln!("sent={} failed={}", stats.sent, stats.failed);
    Ok(())
}