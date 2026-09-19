#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif
uintptr_t UtauTTSCreate(char *config_json);
char *UtauTTSLastError(void);
char *UtauTTSCall(uintptr_t handle, char *method, char *request_json);
void UtauTTSDestroy(uintptr_t handle);
void UtauTTSFree(char *value);
#ifdef __cplusplus
}
#endif
