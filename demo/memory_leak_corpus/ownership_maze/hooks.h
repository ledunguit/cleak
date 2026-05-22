#ifndef OWNERSHIP_MAZE_HOOKS_H
#define OWNERSHIP_MAZE_HOOKS_H

typedef int (*HookValidator)(const char *tag);

int hook_accept(const char *tag);
int hook_reject(const char *tag);
int register_hook_context(const char *tag, HookValidator validator);

#endif
