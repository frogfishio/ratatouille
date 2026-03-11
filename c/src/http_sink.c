/* SPDX-FileCopyrightText: 2026 Alexander R. Croft */
/* SPDX-License-Identifier: MIT */

#include "internal.h"

#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static const char *RAT_HTTP_DEFAULT_PORT = "80";
static const char *RAT_HTTP_DEFAULT_PATH = "/sink";
static const char *RAT_HTTP_DEFAULT_AGENT = "ratatouille-c/0.1";

static int rat_send_all(int fd, const char *buf, size_t len) {
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

static int rat_http_status_ok(const char *buf, size_t len) {
    const char *mark;
    if (!buf || len < 12) return 0;
    if (strncmp(buf, "HTTP/1.", 7) != 0) return 0;
    mark = strchr(buf, ' ');
    if (!mark || (size_t)(mark - buf) + 4 > len) return 0;
    return mark[1] == '2';
}

static int rat_parse_http_url(const char *url, char **host, char **port, char **path) {
    const char *cursor;
    const char *host_start;
    const char *host_end;
    const char *path_start;
    const char *colon;

    if (!url || !host || !port || !path) return -1;
    if (strncmp(url, "http://", 7) != 0) return -1;

    cursor = url + 7;
    host_start = cursor;
    while (*cursor && *cursor != '/' && *cursor != ':') cursor++;
    host_end = cursor;
    if (host_end == host_start) return -1;

    colon = NULL;
    if (*cursor == ':') {
        colon = cursor;
        cursor++;
        while (*cursor && *cursor != '/') cursor++;
    }
    path_start = *cursor ? cursor : RAT_HTTP_DEFAULT_PATH;

    *host = rat_strdup_range(host_start, (size_t)(host_end - host_start));
    if (!*host) return -1;

    if (colon) {
        *port = rat_strdup_range(colon + 1, (size_t)(cursor - (colon + 1)));
    } else {
        *port = rat_strdup_local(RAT_HTTP_DEFAULT_PORT);
    }
    if (!*port) {
        free(*host);
        *host = NULL;
        return -1;
    }

    if (strcmp(path_start, "/") == 0 || *path_start == '\0') {
        *path = rat_strdup_local(RAT_HTTP_DEFAULT_PATH);
    } else {
        *path = rat_strdup_local(path_start);
    }
    if (!*path) {
        free(*host);
        free(*port);
        *host = NULL;
        *port = NULL;
        return -1;
    }

    return 0;
}

rat_http_sink_t *rat_http_sink_create(const rat_http_sink_config_t *config) {
    rat_http_sink_t *sink;

    if (!config || !config->url) return NULL;

    sink = (rat_http_sink_t *)calloc(1, sizeof(rat_http_sink_t));
    if (!sink) return NULL;

    if (rat_parse_http_url(config->url, &sink->host, &sink->port, &sink->path) != 0) {
        rat_http_sink_destroy(sink);
        return NULL;
    }

    sink->token = rat_strdup_local(config->token);
    sink->user_agent = rat_strdup_local(config->user_agent ? config->user_agent : RAT_HTTP_DEFAULT_AGENT);
    if ((config->token && !sink->token) || !sink->user_agent) {
        rat_http_sink_destroy(sink);
        return NULL;
    }

    return sink;
}

void rat_http_sink_destroy(rat_http_sink_t *sink) {
    if (!sink) return;
    free(sink->host);
    free(sink->port);
    free(sink->path);
    free(sink->token);
    free(sink->user_agent);
    free(sink);
}

rat_http_sink_stats_t rat_http_sink_stats(const rat_http_sink_t *sink) {
    rat_http_sink_stats_t stats;
    stats.sent = sink ? sink->sent : 0;
    stats.failed = sink ? sink->failed : 0;
    return stats;
}

int rat_http_sink_post(rat_http_sink_t *sink, const char *line, size_t len) {
    char *body;
    size_t body_len;
    int rc;

    if (!line) return -1;

    body_len = len + 1U;
    body = (char *)malloc(body_len);
    if (!body) return -1;
    memcpy(body, line, len);
    body[len] = '\n';
    rc = rat_http_sink_post_chunk(sink, body, body_len);
    free(body);
    return rc;
}

int rat_http_sink_post_chunk(rat_http_sink_t *sink, const char *chunk, size_t len) {
    struct addrinfo hints;
    struct addrinfo *res = NULL;
    struct addrinfo *it;
    int fd = -1;
    int rc = -1;
    char *request = NULL;
    size_t token_len = 0;
    size_t agent_len;
    size_t req_cap;
    int req_len;
    char response[256];
    ssize_t response_len;

    if (!sink || !chunk) return -1;

    if (sink->token) token_len = strlen(sink->token);
    agent_len = strlen(sink->user_agent);
    req_cap = len + strlen(sink->host) + strlen(sink->path) + agent_len + token_len + 512U;
    request = (char *)malloc(req_cap);
    if (!request) goto cleanup;

    req_len = snprintf(
        request,
        req_cap,
        "POST %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "User-Agent: %s\r\n"
        "Content-Type: application/x-ndjson\r\n"
        "Content-Length: %zu\r\n"
        "%s%s%s"
        "Connection: close\r\n"
        "\r\n",
        sink->path,
        sink->host,
        sink->user_agent,
        len,
        sink->token ? "Authorization: Bearer " : "",
        sink->token ? sink->token : "",
        sink->token ? "\r\n" : ""
    );
    if (req_len < 0 || (size_t)req_len >= req_cap) goto cleanup;

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

    if (rat_send_all(fd, request, (size_t)req_len) != 0) goto cleanup;
    if (rat_send_all(fd, chunk, len) != 0) goto cleanup;

    response_len = recv(fd, response, sizeof(response) - 1U, 0);
    if (response_len <= 0) goto cleanup;
    response[(size_t)response_len] = '\0';
    if (!rat_http_status_ok(response, (size_t)response_len)) goto cleanup;

    sink->sent++;
    rc = 0;

cleanup:
    if (rc != 0 && sink) sink->failed++;
    if (fd >= 0) close(fd);
    if (res) freeaddrinfo(res);
    free(request);
    return rc;
}

void rat_http_sink_callback(const char *line, size_t len, void *userdata) {
    rat_http_sink_t *sink = (rat_http_sink_t *)userdata;
    (void)rat_http_sink_post(sink, line, len);
}
