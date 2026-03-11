/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "internal.h"

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static int rat_appendf(char *dst, size_t dst_cap, size_t *offset, const char *fmt, ...) {
    int written;
    va_list args;

    if (*offset >= dst_cap) return -1;

    va_start(args, fmt);
    written = vsnprintf(dst + *offset, dst_cap - *offset, fmt, args);
    va_end(args);

    if (written < 0) return -1;
    if ((size_t)written >= dst_cap - *offset) return -1;

    *offset += (size_t)written;
    return 0;
}

static int rat_append_json_string(char *dst, size_t dst_cap, size_t *offset, const char *src, size_t src_len) {
    static const char HEX[] = "0123456789abcdef";
    size_t i;

    if (rat_appendf(dst, dst_cap, offset, "\"") != 0) return -1;

    for (i = 0; i < src_len; i++) {
        unsigned char ch = (unsigned char)src[i];

        switch (ch) {
            case '\\':
            case '"':
                if (*offset + 2 >= dst_cap) return -1;
                dst[(*offset)++] = '\\';
                dst[(*offset)++] = (char)ch;
                break;
            case '\b':
                if (rat_appendf(dst, dst_cap, offset, "\\b") != 0) return -1;
                break;
            case '\f':
                if (rat_appendf(dst, dst_cap, offset, "\\f") != 0) return -1;
                break;
            case '\n':
                if (rat_appendf(dst, dst_cap, offset, "\\n") != 0) return -1;
                break;
            case '\r':
                if (rat_appendf(dst, dst_cap, offset, "\\r") != 0) return -1;
                break;
            case '\t':
                if (rat_appendf(dst, dst_cap, offset, "\\t") != 0) return -1;
                break;
            default:
                if (ch >= 0x20 && ch <= 0x7e) {
                    if (*offset + 1 >= dst_cap) return -1;
                    dst[(*offset)++] = (char)ch;
                } else {
                    if (*offset + 6 >= dst_cap) return -1;
                    dst[(*offset)++] = '\\';
                    dst[(*offset)++] = 'u';
                    dst[(*offset)++] = '0';
                    dst[(*offset)++] = '0';
                    dst[(*offset)++] = HEX[(ch >> 4) & 0x0f];
                    dst[(*offset)++] = HEX[ch & 0x0f];
                }
                break;
        }
    }

    if (*offset + 1 >= dst_cap) return -1;
    dst[(*offset)++] = '"';
    dst[*offset] = '\0';
    return 0;
}

static int rat_append_text_payload(char *dst, size_t dst_cap, size_t *offset, const char *src, size_t src_len) {
    static const char HEX[] = "0123456789abcdef";
    size_t i;

    for (i = 0; i < src_len; i++) {
        unsigned char ch = (unsigned char)src[i];

        if (isprint(ch) && ch != '\\') {
            if (*offset + 1 >= dst_cap) return -1;
            dst[(*offset)++] = (char)ch;
            continue;
        }

        if (ch == '\\') {
            if (*offset + 2 >= dst_cap) return -1;
            dst[(*offset)++] = '\\';
            dst[(*offset)++] = '\\';
            continue;
        }

        if (*offset + 4 >= dst_cap) return -1;
        dst[(*offset)++] = '\\';
        dst[(*offset)++] = 'x';
        dst[(*offset)++] = HEX[(ch >> 4) & 0x0f];
        dst[(*offset)++] = HEX[ch & 0x0f];
    }

    dst[*offset] = '\0';
    return 0;
}

static int rat_now_iso8601(char *dst, size_t dst_cap) {
    struct timeval tv;
    struct tm tm;

    if (gettimeofday(&tv, NULL) != 0) return -1;
    if (gmtime_r(&tv.tv_sec, &tm) == NULL) return -1;

    return snprintf(
        dst,
        dst_cap,
        "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        tv.tv_usec / 1000L
    ) > 0 ? 0 : -1;
}

int rat_format_text_line(
    char *dst,
    size_t dst_cap,
    const char *topic,
    uint64_t seq,
    const char *payload,
    size_t payload_len,
    size_t *out_len
) {
    char ts[32];
    size_t offset = 0;

    if (!dst || dst_cap == 0 || !topic || !payload || !out_len) return -1;
    if (rat_now_iso8601(ts, sizeof(ts)) != 0) return -1;
    if (rat_appendf(dst, dst_cap, &offset, "[%s #%06llu] %s - ", ts, (unsigned long long)seq, topic) != 0) return -1;
    if (rat_append_text_payload(dst, dst_cap, &offset, payload, payload_len) != 0) return -1;

    *out_len = offset;
    return 0;
}

int rat_format_ndjson_line(
    char *dst,
    size_t dst_cap,
    const char *topic,
    uint64_t seq,
    const rat_source_identity_t *source,
    const char *payload,
    size_t payload_len,
    size_t *out_len
) {
    char ts[32];
    size_t offset = 0;
    int has_source;

    if (!dst || dst_cap == 0 || !topic || !payload || !out_len) return -1;
    if (rat_now_iso8601(ts, sizeof(ts)) != 0) return -1;

    has_source = source && (source->app || source->where || source->instance);

    if (rat_appendf(dst, dst_cap, &offset, "{\"ts\":") != 0) return -1;
    if (rat_append_json_string(dst, dst_cap, &offset, ts, strlen(ts)) != 0) return -1;
    if (rat_appendf(dst, dst_cap, &offset, ",\"seq\":%llu,\"topic\":", (unsigned long long)seq) != 0) return -1;
    if (rat_append_json_string(dst, dst_cap, &offset, topic, strlen(topic)) != 0) return -1;

    if (has_source) {
        if (rat_appendf(dst, dst_cap, &offset, ",\"src\":{") != 0) return -1;

        if (source->app) {
            if (rat_appendf(dst, dst_cap, &offset, "\"app\":") != 0) return -1;
            if (rat_append_json_string(dst, dst_cap, &offset, source->app, strlen(source->app)) != 0) return -1;
        }
        if (source->where) {
            if (source->app && rat_appendf(dst, dst_cap, &offset, ",") != 0) return -1;
            if (!source->app && rat_appendf(dst, dst_cap, &offset, "\"where\":") != 0) return -1;
            if (source->app && rat_appendf(dst, dst_cap, &offset, "\"where\":") != 0) return -1;
            if (rat_append_json_string(dst, dst_cap, &offset, source->where, strlen(source->where)) != 0) return -1;
        }
        if (source->instance) {
            if ((source->app || source->where) && rat_appendf(dst, dst_cap, &offset, ",") != 0) return -1;
            if (rat_appendf(dst, dst_cap, &offset, "\"instance\":") != 0) return -1;
            if (rat_append_json_string(dst, dst_cap, &offset, source->instance, strlen(source->instance)) != 0) return -1;
        }

        if (rat_appendf(dst, dst_cap, &offset, "}") != 0) return -1;
    }

    if (rat_appendf(dst, dst_cap, &offset, ",\"args\":[") != 0) return -1;
    if (rat_append_json_string(dst, dst_cap, &offset, payload, payload_len) != 0) return -1;
    if (rat_appendf(dst, dst_cap, &offset, "]}") != 0) return -1;

    *out_len = offset;
    return 0;
}
