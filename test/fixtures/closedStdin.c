/* Test-only child. Close both CRT and Win32 stdin handles without exiting,
 * so the parent's broken-pipe termination can be exercised on Windows. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <io.h>

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return 2;
  FILE *ready = NULL;
  if (_wfopen_s(&ready, argv[1], L"w") || !ready) return 2;
  int written = fprintf(ready, "%lu", (unsigned long)GetCurrentProcessId());
  if (fclose(ready) || written < 0) return 2;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  _close(0);
  if (input && input != INVALID_HANDLE_VALUE) CloseHandle(input);
  Sleep(INFINITE);
  return 0;
}
