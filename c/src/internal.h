#ifndef RATATOUILLE_INTERNAL_H
#define RATATOUILLE_INTERNAL_H

#include "../include/ratatouille.h"

typedef struct rat_pattern {
    char *pattern;
    int negated;
} rat_pattern_t;

typedef struct rat_topic_state {
    char *name;
    uint64_t seq;
} rat_topic_state_t;

struct rat_http_sink {
    char *host;
    char *port;
    char *path;
    char *token;
    char *user_agent;
    uint64_t sent;
    uint64_t failed;
};

typedef struct rat_queued_line {
    char *data;
    size_t len;
} rat_queued_line_t;

struct rat_http_relay {
    rat_http_sink_t *sink;
    rat_queued_line_t *queue;
    size_t queue_len;
    size_t queue_cap;
    size_t queued_bytes;
    size_t batch_bytes;
    size_t max_queue_bytes;
    size_t max_queue;
    rat_drop_policy_t drop_policy;
    uint64_t dropped;
    uint64_t dropped_bytes;
    uint64_t sent_batches;
    uint64_t sent_bytes;
    uint64_t failed_flushes;
};

struct rat_logger {
    rat_config_t config;
    rat_pattern_t *patterns;
    size_t pattern_count;
    size_t allow_count;
    size_t deny_count;
    rat_topic_state_t *topics;
    size_t topic_count;
    size_t topic_capacity;
    uint64_t emitted;
    uint64_t dropped;
    uint64_t filtered;
};

int rat_compile_filter(rat_logger_t *logger, const char *filter);
int rat_topic_enabled(const rat_logger_t *logger, const char *topic);

int rat_format_text_line(
    char *dst,
    size_t dst_cap,
    const char *topic,
    uint64_t seq,
    const char *payload,
    size_t payload_len,
    size_t *out_len
);

int rat_format_ndjson_line(
    char *dst,
    size_t dst_cap,
    const char *topic,
    uint64_t seq,
    const rat_source_identity_t *source,
    const char *payload,
    size_t payload_len,
    size_t *out_len
);

char *rat_strdup_range(const char *src, size_t len);
char *rat_strdup_local(const char *src);

#endif
