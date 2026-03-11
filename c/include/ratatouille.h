/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#ifndef RATATOUILLE_H
#define RATATOUILLE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum rat_format {
    RAT_FORMAT_TEXT = 0,
    RAT_FORMAT_NDJSON = 1,
} rat_format_t;

typedef enum rat_drop_policy {
    RAT_DROP_OLDEST = 0,
    RAT_DROP_NEWEST = 1,
} rat_drop_policy_t;

/* The sink receives one fully formatted line without a trailing newline. */
typedef void (*rat_sink_fn)(const char *line, size_t len, void *userdata);

typedef struct rat_source_identity {
    const char *app;
    const char *where;
    const char *instance;
} rat_source_identity_t;

typedef struct rat_config {
    const char *filter;
    rat_format_t format;
    rat_sink_fn sink;
    void *sink_userdata;
    rat_source_identity_t source;
    size_t max_topics;
} rat_config_t;

typedef struct rat_stats {
    uint64_t emitted;
    uint64_t dropped;
    uint64_t filtered;
    uint64_t known_topics;
} rat_stats_t;

typedef struct rat_http_sink_config {
    const char *url;
    const char *token;
    const char *user_agent;
} rat_http_sink_config_t;

typedef struct rat_http_sink_stats {
    uint64_t sent;
    uint64_t failed;
} rat_http_sink_stats_t;

typedef struct rat_tcp_sink_config {
    const char *endpoint;
} rat_tcp_sink_config_t;

typedef struct rat_tcp_sink_stats {
    uint64_t sent;
    uint64_t failed;
} rat_tcp_sink_stats_t;

typedef struct rat_http_relay_config {
    const char *url;
    const char *token;
    const char *user_agent;
    size_t batch_bytes;
    size_t max_queue_bytes;
    size_t max_queue;
    rat_drop_policy_t drop_policy;
} rat_http_relay_config_t;

typedef struct rat_http_relay_stats {
    uint64_t queued;
    uint64_t queued_bytes;
    uint64_t dropped;
    uint64_t dropped_bytes;
    uint64_t sent_batches;
    uint64_t sent_bytes;
    uint64_t failed_flushes;
} rat_http_relay_stats_t;

typedef struct rat_tcp_relay_config {
    const char *endpoint;
    size_t batch_bytes;
    size_t max_queue_bytes;
    size_t max_queue;
    rat_drop_policy_t drop_policy;
} rat_tcp_relay_config_t;

typedef struct rat_tcp_relay_stats {
    uint64_t queued;
    uint64_t queued_bytes;
    uint64_t dropped;
    uint64_t dropped_bytes;
    uint64_t sent_batches;
    uint64_t sent_bytes;
    uint64_t failed_flushes;
} rat_tcp_relay_stats_t;

typedef struct rat_logger rat_logger_t;
typedef struct rat_http_sink rat_http_sink_t;
typedef struct rat_http_relay rat_http_relay_t;
typedef struct rat_tcp_sink rat_tcp_sink_t;
typedef struct rat_tcp_relay rat_tcp_relay_t;

rat_logger_t *rat_logger_create(const rat_config_t *config);
void rat_logger_destroy(rat_logger_t *logger);

int rat_logger_is_enabled(const rat_logger_t *logger, const char *topic);

int rat_log(rat_logger_t *logger, const char *topic, const char *message);
int rat_log_bytes(rat_logger_t *logger, const char *topic, const char *payload, size_t payload_len);
int rat_logf(rat_logger_t *logger, const char *topic, const char *fmt, ...);

rat_stats_t rat_logger_stats(const rat_logger_t *logger);

void rat_stdout_sink(const char *line, size_t len, void *userdata);

rat_http_sink_t *rat_http_sink_create(const rat_http_sink_config_t *config);
void rat_http_sink_destroy(rat_http_sink_t *sink);
rat_http_sink_stats_t rat_http_sink_stats(const rat_http_sink_t *sink);
int rat_http_sink_post(rat_http_sink_t *sink, const char *line, size_t len);
int rat_http_sink_post_chunk(rat_http_sink_t *sink, const char *chunk, size_t len);
void rat_http_sink_callback(const char *line, size_t len, void *userdata);

rat_tcp_sink_t *rat_tcp_sink_create(const rat_tcp_sink_config_t *config);
void rat_tcp_sink_destroy(rat_tcp_sink_t *sink);
rat_tcp_sink_stats_t rat_tcp_sink_stats(const rat_tcp_sink_t *sink);
int rat_tcp_sink_send(rat_tcp_sink_t *sink, const char *line, size_t len);
int rat_tcp_sink_send_chunk(rat_tcp_sink_t *sink, const char *chunk, size_t len);
void rat_tcp_sink_callback(const char *line, size_t len, void *userdata);

rat_http_relay_t *rat_http_relay_create(const rat_http_relay_config_t *config);
void rat_http_relay_destroy(rat_http_relay_t *relay);
rat_http_relay_stats_t rat_http_relay_stats(const rat_http_relay_t *relay);
int rat_http_relay_send_line(rat_http_relay_t *relay, const char *line, size_t len);
int rat_http_relay_flush_now(rat_http_relay_t *relay);
void rat_http_relay_callback(const char *line, size_t len, void *userdata);

rat_tcp_relay_t *rat_tcp_relay_create(const rat_tcp_relay_config_t *config);
void rat_tcp_relay_destroy(rat_tcp_relay_t *relay);
rat_tcp_relay_stats_t rat_tcp_relay_stats(const rat_tcp_relay_t *relay);
int rat_tcp_relay_send_line(rat_tcp_relay_t *relay, const char *line, size_t len);
int rat_tcp_relay_flush_now(rat_tcp_relay_t *relay);
void rat_tcp_relay_callback(const char *line, size_t len, void *userdata);

#ifdef __cplusplus
}
#endif

#endif
