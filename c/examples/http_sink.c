#include "ratatouille.h"

#include <stdio.h>

int main(void) {
    rat_http_sink_config_t http_cfg = {0};
    rat_config_t cfg = {0};
    rat_http_sink_t *http_sink;
    rat_logger_t *log;
    rat_http_sink_stats_t http_stats;

    http_cfg.url = "http://127.0.0.1:8080/sink";
    http_cfg.user_agent = "ratatouille-c-example/0.1";

    http_sink = rat_http_sink_create(&http_cfg);
    if (!http_sink) {
        fprintf(stderr, "failed to create HTTP sink\n");
        return 1;
    }

    cfg.filter = "api*";
    cfg.format = RAT_FORMAT_NDJSON;
    cfg.sink = rat_http_sink_callback;
    cfg.sink_userdata = http_sink;
    cfg.source.app = "example";
    cfg.source.where = "c";
    cfg.source.instance = "local";

    log = rat_logger_create(&cfg);
    if (!log) {
        fprintf(stderr, "failed to create logger\n");
        rat_http_sink_destroy(http_sink);
        return 1;
    }

    rat_log(log, "api", "hello over HTTP");
    rat_logf(log, "api", "seq payload=%d", 2);

    http_stats = rat_http_sink_stats(http_sink);
    fprintf(
        stderr,
        "http_sent=%llu http_failed=%llu\n",
        (unsigned long long)http_stats.sent,
        (unsigned long long)http_stats.failed
    );

    rat_logger_destroy(log);
    rat_http_sink_destroy(http_sink);
    return 0;
}
