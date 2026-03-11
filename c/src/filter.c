/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "internal.h"

#include <stdlib.h>
#include <string.h>

static void rat_free_patterns(rat_logger_t *logger) {
    size_t i;

    if (!logger || !logger->patterns) return;
    for (i = 0; i < logger->pattern_count; i++) {
        free(logger->patterns[i].pattern);
    }
    free(logger->patterns);
    logger->patterns = NULL;
    logger->pattern_count = 0;
    logger->allow_count = 0;
    logger->deny_count = 0;
}

static char *rat_slice_dup(const char *start, size_t len) {
    char *copy;

    copy = (char *)malloc(len + 1);
    if (!copy) return NULL;

    memcpy(copy, start, len);
    copy[len] = '\0';
    return copy;
}

static int rat_push_pattern(rat_logger_t *logger, const char *token, size_t len, int negated) {
    rat_pattern_t *next;
    char *pattern;

    pattern = rat_slice_dup(token, len);
    if (!pattern) return -1;

    next = (rat_pattern_t *)realloc(logger->patterns, sizeof(rat_pattern_t) * (logger->pattern_count + 1));
    if (!next) {
        free(pattern);
        return -1;
    }

    logger->patterns = next;
    logger->patterns[logger->pattern_count].pattern = pattern;
    logger->patterns[logger->pattern_count].negated = negated;
    logger->pattern_count++;
    if (negated) logger->deny_count++;
    else logger->allow_count++;
    return 0;
}

static int rat_is_delim(char ch) {
    return ch == ',' || ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n';
}

static int rat_wildcard_match(const char *pattern, const char *text) {
    const char *star = NULL;
    const char *retry = NULL;

    while (*text) {
        if (*pattern == '*') {
            star = pattern++;
            retry = text;
            continue;
        }

        if (*pattern == *text) {
            pattern++;
            text++;
            continue;
        }

        if (!star) return 0;

        pattern = star + 1;
        text = ++retry;
    }

    while (*pattern == '*') pattern++;
    return *pattern == '\0';
}

int rat_compile_filter(rat_logger_t *logger, const char *filter) {
    const char *cursor;

    if (!logger) return -1;

    rat_free_patterns(logger);
    if (!filter || !*filter) return 0;

    cursor = filter;
    while (*cursor) {
        const char *start;
        size_t len;
        int negated;

        while (*cursor && rat_is_delim(*cursor)) cursor++;
        if (!*cursor) break;

        negated = *cursor == '-';
        if (negated) cursor++;

        start = cursor;
        while (*cursor && !rat_is_delim(*cursor)) cursor++;
        len = (size_t)(cursor - start);
        if (len == 0) continue;

        if (rat_push_pattern(logger, start, len, negated) != 0) {
            rat_free_patterns(logger);
            return -1;
        }
    }

    return 0;
}

int rat_topic_enabled(const rat_logger_t *logger, const char *topic) {
    int allowed;
    size_t i;

    if (!logger || !topic || !*topic) return 0;
    if (logger->allow_count == 0 && logger->deny_count == 0) return 0;

    allowed = logger->allow_count == 0 && logger->deny_count > 0;

    for (i = 0; i < logger->pattern_count; i++) {
        const rat_pattern_t *pattern = &logger->patterns[i];
        if (!rat_wildcard_match(pattern->pattern, topic)) continue;
        if (pattern->negated) return 0;
        allowed = 1;
    }

    return allowed;
}
