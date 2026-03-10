use ratatouille::{Format, Logger, LoggerConfig, SourceIdentity};

fn main() {
    let mut config = LoggerConfig::default();
    config.filter = Some("api*,-api:noise".to_owned());
    config.format = Format::Ndjson;
    config.source = SourceIdentity {
        app: Some("example".to_owned()),
        r#where: Some("rust".to_owned()),
        instance: Some("local".to_owned()),
    };

    let mut logger = Logger::new(config);
    let _ = logger.log("api", "hello from Rust");
    let _ = logger.log("api", "user=alice req=42");
    let _ = logger.log("api:noise", "this should be filtered");

    let stats = logger.stats();
    eprintln!(
        "emitted={} filtered={} dropped={} topics={}",
        stats.emitted, stats.filtered, stats.dropped, stats.known_topics
    );
}