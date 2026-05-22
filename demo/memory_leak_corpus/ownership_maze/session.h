#ifndef OWNERSHIP_MAZE_SESSION_H
#define OWNERSHIP_MAZE_SESSION_H

typedef struct {
    char *name;
    char *cached_route;
    char *request_context;
    int mode;
} Session;

Session *session_open(const char *user, int mode);
void session_rename(Session *session, const char *name);
void session_replace_route(Session *session, const char *route);
char **build_retry_batch(int count, int fail_index);
void session_close_buggy(Session *session);

#endif
