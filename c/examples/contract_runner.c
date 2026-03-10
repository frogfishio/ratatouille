#include "ratatouille.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct session {
    char *name;
    char *filter;
    rat_logger_t *logger;
    char last_line[2048];
    size_t last_len;
    struct session *next;
} session_t;

static char *dup_local(const char *src) {
    size_t len = strlen(src);
    char *copy = (char *)malloc(len + 1U);
    if (!copy) return NULL;
    memcpy(copy, src, len + 1U);
    return copy;
}

static void capture_sink(const char *line, size_t len, void *userdata) {
    session_t *session = (session_t *)userdata;
    if (!session || !line) return;
    if (len >= sizeof(session->last_line)) len = sizeof(session->last_line) - 1U;
    memcpy(session->last_line, line, len);
    session->last_line[len] = '\0';
    session->last_len = len;
}

static long parse_seq(const char *line) {
    const char *mark = strstr(line, "\"seq\":");
    if (!mark) return -1;
    return strtol(mark + 6, NULL, 10);
}

static session_t *find_session(session_t *head, const char *name) {
    while (head) {
        if (strcmp(head->name, name) == 0) return head;
        head = head->next;
    }
    return NULL;
}

static session_t *ensure_session(session_t **head, const char *name, const char *filter) {
    rat_config_t cfg;
    session_t *session = find_session(*head, name);
    if (session) {
        if (strcmp(session->filter, filter) != 0) return NULL;
        return session;
    }

    session = (session_t *)calloc(1, sizeof(session_t));
    if (!session) return NULL;
    session->name = dup_local(name);
    session->filter = dup_local(filter);
    if (!session->name || !session->filter) return NULL;

    memset(&cfg, 0, sizeof(cfg));
    cfg.filter = strcmp(filter, "-") == 0 ? NULL : session->filter;
    cfg.format = RAT_FORMAT_NDJSON;
    cfg.sink = capture_sink;
    cfg.sink_userdata = session;
    cfg.max_topics = 128;

    session->logger = rat_logger_create(&cfg);
    if (!session->logger) return NULL;
    session->next = *head;
    *head = session;
    return session;
}

static void free_sessions(session_t *head) {
    session_t *next;
    while (head) {
        next = head->next;
        rat_logger_destroy(head->logger);
        free(head->name);
        free(head->filter);
        free(head);
        head = next;
    }
}

int main(int argc, char **argv) {
    FILE *fp;
    char line[4096];
    session_t *sessions = NULL;
    int cases = 0;

    if (argc != 2) {
        fprintf(stderr, "usage: %s contract/cases.tsv\n", argv[0]);
        return 1;
    }

    fp = fopen(argv[1], "r");
    if (!fp) {
        perror("fopen");
        return 1;
    }

    while (fgets(line, sizeof(line), fp)) {
        char *fields[6] = {0};
        char *cursor = line;
        char *nl;
        session_t *session;
        int result;

        if (line[0] == '#' || line[0] == '\n') continue;
        nl = strchr(line, '\n');
        if (nl) *nl = '\0';

        for (int i = 0; i < 6; i++) {
            fields[i] = i == 0 ? strtok(cursor, "\t") : strtok(NULL, "\t");
            cursor = NULL;
        }
        if (!fields[0] || !fields[1] || !fields[2] || !fields[3] || !fields[4] || !fields[5]) {
            fprintf(stderr, "invalid contract row\n");
            free_sessions(sessions);
            fclose(fp);
            return 1;
        }

        session = ensure_session(&sessions, fields[0], fields[1]);
        if (!session) {
            fprintf(stderr, "failed to create session %s\n", fields[0]);
            free_sessions(sessions);
            fclose(fp);
            return 1;
        }

        session->last_len = 0;
        session->last_line[0] = '\0';
        result = rat_log(session->logger, fields[2], fields[3]);

        if (strcmp(fields[4], "emit") == 0) {
            long seq;
            if (result != 1 || session->last_len == 0) {
                fprintf(stderr, "c contract failed: expected emit for %s/%s\n", fields[0], fields[2]);
                free_sessions(sessions);
                fclose(fp);
                return 1;
            }
            seq = parse_seq(session->last_line);
            if (seq < 0 || seq != strtol(fields[5], NULL, 10)) {
                fprintf(stderr, "c contract failed: expected seq %s for %s/%s\n", fields[5], fields[0], fields[2]);
                free_sessions(sessions);
                fclose(fp);
                return 1;
            }
        } else if (result != 0 || session->last_len != 0) {
            fprintf(stderr, "c contract failed: expected filter for %s/%s\n", fields[0], fields[2]);
            free_sessions(sessions);
            fclose(fp);
            return 1;
        }

        cases++;
    }

    fclose(fp);
    free_sessions(sessions);
    printf("c contract ok: %d cases\n", cases);
    return 0;
}
