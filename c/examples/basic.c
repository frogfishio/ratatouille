/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "ratatouille.h"

#include <stdio.h>

int main(void) {
    rat_config_t cfg = {0};
    rat_logger_t *log;
    rat_stats_t stats;

    cfg.filter = "api*,-api:noise";
    cfg.format = RAT_FORMAT_NDJSON;
    cfg.source.app = "example";
    cfg.source.where = "c";
    cfg.source.instance = "local";
    cfg.max_topics = 32;

    log = rat_logger_create(&cfg);
    if (!log) {
        fprintf(stderr, "failed to create ratatouille logger\n");
        return 1;
    }

    rat_log(log, "api", "hello from C");
    rat_logf(log, "api", "user=%s req=%d", "alice", 42);
    rat_log(log, "api:noise", "this should be filtered");

    stats = rat_logger_stats(log);
    fprintf(
        stderr,
        "emitted=%llu filtered=%llu dropped=%llu topics=%llu\n",
        (unsigned long long)stats.emitted,
        (unsigned long long)stats.filtered,
        (unsigned long long)stats.dropped,
        (unsigned long long)stats.known_topics
    );

    rat_logger_destroy(log);
    return 0;
}
