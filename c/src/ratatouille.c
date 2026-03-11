/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "internal.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RAT_DEFAULT_MAX_TOPICS 256U

char *rat_strdup_local(const char *src) {
    size_t len;

    if (!src) return NULL;
    len = strlen(src);
    return rat_strdup_range(src, len);
}

char *rat_strdup_range(const char *src, size_t len) {
    char *copy;

    if (!src) return NULL;
    copy = (char *)malloc(len + 1);
    if (!copy) return NULL;
    memcpy(copy, src, len);
    copy[len] = '\0';
    return copy;
}

static rat_topic_state_t *rat_get_topic(rat_logger_t *logger, const char *topic) {
    size_t i;

    for (i = 0; i < logger->topic_count; i++) {
        if (strcmp(logger->topics[i].name, topic) == 0) return &logger->topics[i];
    }

    if (logger->topic_count >= logger->topic_capacity) return NULL;

    logger->topics[logger->topic_count].name = rat_strdup_local(topic);
    if (!logger->topics[logger->topic_count].name) return NULL;

    logger->topics[logger->topic_count].seq = 0;
    logger->topic_count++;
    return &logger->topics[logger->topic_count - 1];
}

static size_t rat_line_capacity(const char *topic, const char *payload, size_t payload_len) {
    size_t topic_len = strlen(topic);
    size_t base = 256U;
    size_t topic_cap = topic_len * 6U;
    size_t payload_cap = payload_len * 6U;
    size_t source_cap = 192U;
    (void)payload;
    return base + topic_cap + payload_cap + source_cap;
}

static int rat_emit(rat_logger_t *logger, const char *topic, const char *payload, size_t payload_len) {
    char stack[1024];
    char *line = stack;
    size_t cap;
    size_t len = 0;
    rat_topic_state_t *state;
    int ok;

    if (!logger || !topic || !*topic) return -1;
    if (!payload) {
        payload = "";
        payload_len = 0;
    }

    if (!rat_topic_enabled(logger, topic)) {
        logger->filtered++;
        return 0;
    }

    state = rat_get_topic(logger, topic);
    if (!state) {
        logger->dropped++;
        return 0;
    }

    state->seq++;
    cap = rat_line_capacity(topic, payload, payload_len);
    if (cap > sizeof(stack)) {
        line = (char *)malloc(cap);
        if (!line) {
            logger->dropped++;
            return -1;
        }
    }

    if (logger->config.format == RAT_FORMAT_NDJSON) {
        ok = rat_format_ndjson_line(line, cap, topic, state->seq, &logger->config.source, payload, payload_len, &len);
    } else {
        ok = rat_format_text_line(line, cap, topic, state->seq, payload, payload_len, &len);
    }

    if (ok != 0) {
        if (line != stack) free(line);
        logger->dropped++;
        return -1;
    }

    logger->config.sink(line, len, logger->config.sink_userdata);
    logger->emitted++;

    if (line != stack) free(line);
    return 1;
}

rat_logger_t *rat_logger_create(const rat_config_t *config) {
    rat_logger_t *logger;
    size_t max_topics;

    logger = (rat_logger_t *)calloc(1, sizeof(rat_logger_t));
    if (!logger) return NULL;

    if (config) logger->config = *config;
    logger->config.format = config ? config->format : RAT_FORMAT_TEXT;
    logger->config.sink = (config && config->sink) ? config->sink : rat_stdout_sink;
    logger->config.sink_userdata = config ? config->sink_userdata : NULL;

    max_topics = (config && config->max_topics) ? config->max_topics : RAT_DEFAULT_MAX_TOPICS;
    logger->topic_capacity = max_topics;
    logger->topics = (rat_topic_state_t *)calloc(max_topics, sizeof(rat_topic_state_t));
    if (!logger->topics) {
        free(logger);
        return NULL;
    }

    if (rat_compile_filter(logger, config ? config->filter : NULL) != 0) {
        rat_logger_destroy(logger);
        return NULL;
    }

    return logger;
}

void rat_logger_destroy(rat_logger_t *logger) {
    size_t i;

    if (!logger) return;

    if (logger->patterns) {
        for (i = 0; i < logger->pattern_count; i++) {
            free(logger->patterns[i].pattern);
        }
        free(logger->patterns);
    }

    if (logger->topics) {
        for (i = 0; i < logger->topic_count; i++) {
            free(logger->topics[i].name);
        }
        free(logger->topics);
    }

    free(logger);
}

int rat_logger_is_enabled(const rat_logger_t *logger, const char *topic) {
    return rat_topic_enabled(logger, topic);
}

int rat_log(rat_logger_t *logger, const char *topic, const char *message) {
    size_t len = message ? strlen(message) : 0;
    return rat_emit(logger, topic, message, len);
}

int rat_log_bytes(rat_logger_t *logger, const char *topic, const char *payload, size_t payload_len) {
    return rat_emit(logger, topic, payload, payload_len);
}

int rat_logf(rat_logger_t *logger, const char *topic, const char *fmt, ...) {
    char stack[512];
    char *buffer = stack;
    int needed;
    va_list args;
    va_list copy;
    int result;

    if (!fmt) return rat_emit(logger, topic, "", 0);

    va_start(args, fmt);
    va_copy(copy, args);
    needed = vsnprintf(stack, sizeof(stack), fmt, copy);
    va_end(copy);

    if (needed < 0) {
        va_end(args);
        return -1;
    }

    if ((size_t)needed >= sizeof(stack)) {
        buffer = (char *)malloc((size_t)needed + 1U);
        if (!buffer) {
            va_end(args);
            return -1;
        }
        vsnprintf(buffer, (size_t)needed + 1U, fmt, args);
    }

    va_end(args);
    result = rat_emit(logger, topic, buffer, (size_t)needed);

    if (buffer != stack) free(buffer);
    return result;
}

rat_stats_t rat_logger_stats(const rat_logger_t *logger) {
    rat_stats_t stats;

    memset(&stats, 0, sizeof(stats));
    if (!logger) return stats;

    stats.emitted = logger->emitted;
    stats.dropped = logger->dropped;
    stats.filtered = logger->filtered;
    stats.known_topics = (uint64_t)logger->topic_count;
    return stats;
}

void rat_stdout_sink(const char *line, size_t len, void *userdata) {
    FILE *stream = userdata ? (FILE *)userdata : stdout;
    if (!line || !stream) return;
    (void)fwrite(line, 1, len, stream);
    (void)fputc('\n', stream);
}
