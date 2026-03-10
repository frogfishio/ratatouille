#include "ratatouille.h"

#include <stdio.h>

int main(void) {
    rat_http_relay_config_t relay_cfg = {0};
    rat_config_t cfg = {0};
    rat_http_relay_t *relay;
    rat_logger_t *log;
    rat_http_relay_stats_t relay_stats;

    relay_cfg.url = "http://127.0.0.1:8080/sink";
    relay_cfg.user_agent = "ratatouille-c-relay/0.1";
    relay_cfg.batch_bytes = 4096;
    relay_cfg.max_queue_bytes = 65536;
    relay_cfg.max_queue = 128;
    relay_cfg.drop_policy = RAT_DROP_OLDEST;

    relay = rat_http_relay_create(&relay_cfg);
    if (!relay) {
        fprintf(stderr, "failed to create HTTP relay\n");
        return 1;
    }

    cfg.filter = "api*";
    cfg.format = RAT_FORMAT_NDJSON;
    cfg.sink = rat_http_relay_callback;
    cfg.sink_userdata = relay;
    cfg.source.app = "example";
    cfg.source.where = "c";
    cfg.source.instance = "local";

    log = rat_logger_create(&cfg);
    if (!log) {
        fprintf(stderr, "failed to create logger\n");
        rat_http_relay_destroy(relay);
        return 1;
    }

    rat_log(log, "api", "queued one");
    rat_log(log, "api", "queued two");
    rat_logf(log, "api", "queued value=%d", 3);

    if (rat_http_relay_flush_now(relay) < 0) {
        fprintf(stderr, "relay flush failed\n");
    }

    relay_stats = rat_http_relay_stats(relay);
    fprintf(
        stderr,
        "queued=%llu dropped=%llu sent_batches=%llu sent_bytes=%llu failed_flushes=%llu\n",
        (unsigned long long)relay_stats.queued,
        (unsigned long long)relay_stats.dropped,
        (unsigned long long)relay_stats.sent_batches,
        (unsigned long long)relay_stats.sent_bytes,
        (unsigned long long)relay_stats.failed_flushes
    );

    rat_logger_destroy(log);
    rat_http_relay_destroy(relay);
    return 0;
}
