/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "ratatouille.h"

#include <stdio.h>

int main(void) {
    rat_tcp_sink_config_t sink_cfg = {0};
    rat_config_t cfg = {0};
    rat_tcp_sink_t *sink;
    rat_logger_t *log;
    rat_tcp_sink_stats_t sink_stats;

    sink_cfg.endpoint = "tcp://127.0.0.1:9000";
    sink = rat_tcp_sink_create(&sink_cfg);
    if (!sink) {
        fprintf(stderr, "failed to create TCP sink\n");
        return 1;
    }

    cfg.filter = "api*";
    cfg.format = RAT_FORMAT_NDJSON;
    cfg.sink = rat_tcp_sink_callback;
    cfg.sink_userdata = sink;
    cfg.source.app = "example";
    cfg.source.where = "c";
    cfg.source.instance = "local";

    log = rat_logger_create(&cfg);
    if (!log) {
        fprintf(stderr, "failed to create logger\n");
        rat_tcp_sink_destroy(sink);
        return 1;
    }

    rat_log(log, "api", "sent over tcp");
    rat_logf(log, "api", "value=%d", 42);

    sink_stats = rat_tcp_sink_stats(sink);
    fprintf(
        stderr,
        "sent=%llu failed=%llu\n",
        (unsigned long long)sink_stats.sent,
        (unsigned long long)sink_stats.failed
    );

    rat_logger_destroy(log);
    rat_tcp_sink_destroy(sink);
    return 0;
}
