#include "internal.h"

#include <stdlib.h>
#include <string.h>

#define RAT_RELAY_DEFAULT_BATCH_BYTES 262144U
#define RAT_RELAY_DEFAULT_MAX_QUEUE_BYTES 5242880U
#define RAT_RELAY_DEFAULT_MAX_QUEUE 10000U

static void rat_http_relay_drop_oldest(rat_http_relay_t *relay) {
    if (!relay || relay->queue_len == 0) return;

    relay->dropped++;
    relay->dropped_bytes += relay->queue[0].len;
    relay->queued_bytes -= relay->queue[0].len;
    free(relay->queue[0].data);

    if (relay->queue_len > 1) {
        memmove(&relay->queue[0], &relay->queue[1], sizeof(rat_queued_line_t) * (relay->queue_len - 1));
    }
    relay->queue_len--;
}

static int rat_http_relay_reserve(rat_http_relay_t *relay) {
    rat_queued_line_t *next;
    size_t next_cap;

    if (relay->queue_len < relay->queue_cap) return 0;

    next_cap = relay->queue_cap ? relay->queue_cap * 2U : 64U;
    if (next_cap > relay->max_queue) next_cap = relay->max_queue;
    if (next_cap <= relay->queue_cap) return -1;

    next = (rat_queued_line_t *)realloc(relay->queue, sizeof(rat_queued_line_t) * next_cap);
    if (!next) return -1;

    relay->queue = next;
    relay->queue_cap = next_cap;
    return 0;
}

static int rat_http_relay_make_room(rat_http_relay_t *relay, size_t len) {
    if (!relay) return -1;

    if (len > relay->batch_bytes) return -1;

    while ((relay->queue_len >= relay->max_queue || relay->queued_bytes + len > relay->max_queue_bytes) && relay->queue_len > 0) {
        if (relay->drop_policy == RAT_DROP_NEWEST) return -1;
        rat_http_relay_drop_oldest(relay);
    }

    if (relay->queue_len >= relay->max_queue) return -1;
    if (relay->queued_bytes + len > relay->max_queue_bytes) return -1;
    return 0;
}

rat_http_relay_t *rat_http_relay_create(const rat_http_relay_config_t *config) {
    rat_http_relay_t *relay;
    rat_http_sink_config_t sink_cfg;

    if (!config || !config->url) return NULL;

    relay = (rat_http_relay_t *)calloc(1, sizeof(rat_http_relay_t));
    if (!relay) return NULL;

    memset(&sink_cfg, 0, sizeof(sink_cfg));
    sink_cfg.url = config->url;
    sink_cfg.token = config->token;
    sink_cfg.user_agent = config->user_agent;

    relay->sink = rat_http_sink_create(&sink_cfg);
    if (!relay->sink) {
        rat_http_relay_destroy(relay);
        return NULL;
    }

    relay->batch_bytes = config->batch_bytes ? config->batch_bytes : RAT_RELAY_DEFAULT_BATCH_BYTES;
    relay->max_queue_bytes = config->max_queue_bytes ? config->max_queue_bytes : RAT_RELAY_DEFAULT_MAX_QUEUE_BYTES;
    relay->max_queue = config->max_queue ? config->max_queue : RAT_RELAY_DEFAULT_MAX_QUEUE;
    relay->drop_policy = config->drop_policy;
    return relay;
}

void rat_http_relay_destroy(rat_http_relay_t *relay) {
    size_t i;

    if (!relay) return;
    for (i = 0; i < relay->queue_len; i++) free(relay->queue[i].data);
    free(relay->queue);
    rat_http_sink_destroy(relay->sink);
    free(relay);
}

rat_http_relay_stats_t rat_http_relay_stats(const rat_http_relay_t *relay) {
    rat_http_relay_stats_t stats;

    memset(&stats, 0, sizeof(stats));
    if (!relay) return stats;
    stats.queued = relay->queue_len;
    stats.queued_bytes = relay->queued_bytes;
    stats.dropped = relay->dropped;
    stats.dropped_bytes = relay->dropped_bytes;
    stats.sent_batches = relay->sent_batches;
    stats.sent_bytes = relay->sent_bytes;
    stats.failed_flushes = relay->failed_flushes;
    return stats;
}

int rat_http_relay_send_line(rat_http_relay_t *relay, const char *line, size_t len) {
    char *copy;

    if (!relay || !line) return -1;
    if (rat_http_relay_make_room(relay, len + 1U) != 0) {
        relay->dropped++;
        relay->dropped_bytes += len + 1U;
        return 0;
    }
    if (rat_http_relay_reserve(relay) != 0) {
        relay->dropped++;
        relay->dropped_bytes += len + 1U;
        return -1;
    }

    copy = (char *)malloc(len + 1U);
    if (!copy) {
        relay->dropped++;
        relay->dropped_bytes += len + 1U;
        return -1;
    }
    memcpy(copy, line, len);
    copy[len] = '\n';

    relay->queue[relay->queue_len].data = copy;
    relay->queue[relay->queue_len].len = len + 1U;
    relay->queue_len++;
    relay->queued_bytes += len + 1U;
    return 1;
}

int rat_http_relay_flush_now(rat_http_relay_t *relay) {
    size_t i;
    size_t batch_len = 0;
    char *batch;
    int rc;

    if (!relay) return -1;
    if (relay->queue_len == 0) return 0;

    for (i = 0; i < relay->queue_len; i++) {
        if (batch_len + relay->queue[i].len > relay->batch_bytes) break;
        batch_len += relay->queue[i].len;
    }
    if (i == 0) {
        relay->dropped++;
        relay->dropped_bytes += relay->queue[0].len;
        rat_http_relay_drop_oldest(relay);
        return 0;
    }

    batch = (char *)malloc(batch_len);
    if (!batch) {
        relay->failed_flushes++;
        return -1;
    }

    batch_len = 0;
    for (size_t j = 0; j < i; j++) {
        memcpy(batch + batch_len, relay->queue[j].data, relay->queue[j].len);
        batch_len += relay->queue[j].len;
    }

    rc = rat_http_sink_post_chunk(relay->sink, batch, batch_len);
    if (rc != 0) {
        relay->failed_flushes++;
        free(batch);
        return -1;
    }

    for (size_t j = 0; j < i; j++) free(relay->queue[j].data);
    if (i < relay->queue_len) {
        memmove(&relay->queue[0], &relay->queue[i], sizeof(rat_queued_line_t) * (relay->queue_len - i));
    }
    relay->queue_len -= i;
    relay->queued_bytes -= batch_len;
    relay->sent_batches++;
    relay->sent_bytes += batch_len;
    free(batch);
    return 1;
}

void rat_http_relay_callback(const char *line, size_t len, void *userdata) {
    rat_http_relay_t *relay = (rat_http_relay_t *)userdata;
    (void)rat_http_relay_send_line(relay, line, len);
}
