/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "internal.h"

#include <errno.h>
#include <netdb.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static int rat_tcp_send_all(int fd, const char *buf, size_t len) {
    while (len > 0) {
        ssize_t n = send(fd, buf, len, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        buf += (size_t)n;
        len -= (size_t)n;
    }
    return 0;
}

static int rat_parse_tcp_endpoint(const char *endpoint, char **host, char **port) {
    const char *cursor;
    const char *host_start;
    const char *host_end;
    const char *colon;

    if (!endpoint || !host || !port) return -1;
    if (strncmp(endpoint, "tcp://", 6) != 0) return -1;

    cursor = endpoint + 6;
    host_start = cursor;
    while (*cursor && *cursor != ':') cursor++;
    host_end = cursor;
    if (host_end == host_start || *cursor != ':') return -1;

    colon = cursor;
    cursor++;
    if (*cursor == '\0') return -1;

    *host = rat_strdup_range(host_start, (size_t)(host_end - host_start));
    if (!*host) return -1;

    *port = rat_strdup_local(colon + 1);
    if (!*port) {
        free(*host);
        *host = NULL;
        return -1;
    }

    return 0;
}

rat_tcp_sink_t *rat_tcp_sink_create(const rat_tcp_sink_config_t *config) {
    rat_tcp_sink_t *sink;

    if (!config || !config->endpoint) return NULL;

    sink = (rat_tcp_sink_t *)calloc(1, sizeof(rat_tcp_sink_t));
    if (!sink) return NULL;

    if (rat_parse_tcp_endpoint(config->endpoint, &sink->host, &sink->port) != 0) {
        rat_tcp_sink_destroy(sink);
        return NULL;
    }

    return sink;
}

void rat_tcp_sink_destroy(rat_tcp_sink_t *sink) {
    if (!sink) return;
    free(sink->host);
    free(sink->port);
    free(sink);
}

rat_tcp_sink_stats_t rat_tcp_sink_stats(const rat_tcp_sink_t *sink) {
    rat_tcp_sink_stats_t stats;
    stats.sent = sink ? sink->sent : 0;
    stats.failed = sink ? sink->failed : 0;
    return stats;
}

int rat_tcp_sink_send(rat_tcp_sink_t *sink, const char *line, size_t len) {
    char *body;
    size_t body_len;
    int rc;

    if (!line) return -1;

    body_len = len + 1U;
    body = (char *)malloc(body_len);
    if (!body) return -1;
    memcpy(body, line, len);
    body[len] = '\n';
    rc = rat_tcp_sink_send_chunk(sink, body, body_len);
    free(body);
    return rc;
}

int rat_tcp_sink_send_chunk(rat_tcp_sink_t *sink, const char *chunk, size_t len) {
    struct addrinfo hints;
    struct addrinfo *res = NULL;
    struct addrinfo *it;
    int fd = -1;
    int rc = -1;

    if (!sink || !chunk) return -1;

    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    if (getaddrinfo(sink->host, sink->port, &hints, &res) != 0) goto cleanup;

    for (it = res; it; it = it->ai_next) {
        fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, it->ai_addr, it->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    if (fd < 0) goto cleanup;

    if (rat_tcp_send_all(fd, chunk, len) != 0) goto cleanup;

    sink->sent++;
    rc = 0;

cleanup:
    if (rc != 0 && sink) sink->failed++;
    if (fd >= 0) close(fd);
    if (res) freeaddrinfo(res);
    return rc;
}

void rat_tcp_sink_callback(const char *line, size_t len, void *userdata) {
    rat_tcp_sink_t *sink = (rat_tcp_sink_t *)userdata;
    (void)rat_tcp_sink_send(sink, line, len);
}
