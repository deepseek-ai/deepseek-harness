#pragma once
#include "transport.h"
typedef struct dsh_frame_forwarding_client dsh_frame_forwarding_client;
typedef struct dsh_frame_forwarding_surface dsh_frame_forwarding_surface;
typedef struct dsh_frame_forwarding_event { int kind; char text[DSH_FRAME_FORWARDING_TEXT_CAPACITY]; } dsh_frame_forwarding_event;
dsh_frame_forwarding_client* dsh_frame_forwarding_connect(const char* tx, char* error, size_t error_size);
typedef struct dsh_frame_forwarding_connect_options {
  void* device;
  uint32_t timeout_ms;
  void* cancellation_context;
  int (*cancelled)(void*);
} dsh_frame_forwarding_connect_options;
dsh_frame_forwarding_client* dsh_frame_forwarding_connect_with_options(const char* tx,
  const dsh_frame_forwarding_connect_options* options, char* error, size_t error_size);
dsh_frame_forwarding_surface* dsh_frame_forwarding_acquire(dsh_frame_forwarding_client* client, uint32_t width, uint32_t height);
int dsh_frame_forwarding_write_bgra(dsh_frame_forwarding_surface* surface, const void* pixels, size_t stride);
int dsh_frame_forwarding_submit(dsh_frame_forwarding_client* client, dsh_frame_forwarding_surface* surface, uint64_t frame_id, const char* metadata_json);
int dsh_frame_forwarding_trim(dsh_frame_forwarding_client* client);
int dsh_frame_forwarding_poll(dsh_frame_forwarding_client* client, uint32_t timeout_ms, dsh_frame_forwarding_event* event);
int dsh_frame_forwarding_send(dsh_frame_forwarding_client* client, const char* json);
void dsh_frame_forwarding_close(dsh_frame_forwarding_client* client);
