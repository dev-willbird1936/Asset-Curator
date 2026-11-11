# Release validation

Version 0.2.0. Hermes 0.23.1, Windows.

- Development test command: 18 test programs passed.
- Clean package: official `hermes plugins doctor <package> --ci` passed.
- Official `hermes plugins validate <package>` passed, including **security scan: safe**.
- Native registration count is zero, as expected for a portable MCP package.
- Actual MCP discovery in a separately installed copy exposed 16 tools. Normal untrusted write denial and restart recovery passed.
- The 82 runtime files match BUILD.json SHA256 entries; runtime digest `bd16de3645ec69d281ccf14196cb096e24af8cfdf4e70f51703c1fd005e74e09`.

## Limits

Doctor/Validate do not prove every provider is live or every request produces the desired art. macOS/Linux have not been tested. Audio outputs were not auditioned. This release is not a guarantee of catalog acceptance.
