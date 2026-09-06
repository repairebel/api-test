# Admin security activity and responsive UI

This change is scoped to the test server and admin workspace. Production has not been changed.

The `login_activity` table records successful sign-ins for customer, shop-owner, and admin accounts. It stores the user type, client IP, platform, a derived device/browser label, optional proxy-provided location, user agent, and timestamp. It never stores access tokens, refresh tokens, or passwords. The login route reads Railway/proxy forwarding headers and the request user agent; location is left empty when the proxy does not provide a trusted city/country value.

`GET /v1/admin/users/:id` now returns the latest 20 sign-in records and a `lastLogin` summary. Only authenticated admins can access this route. The admin Users dialog renders the activity beside the account details with responsive scrolling and a clear empty state.

Migration `0006_login_activity.sql` creates the table and indexes. The isolated test database was rebuilt successfully and reports 40 public tables. Apply this migration to the test Railway database during deployment; do not run it against production until that environment is explicitly requested.

The shared admin shell now uses `min-w-0`, responsive gutters, horizontal table scrolling, and a bounded responsive dialog. These changes address clipped tables, header overflow, and dialogs extending beyond smaller screens across all tabs.

Validation completed: `npm run build` in the test server, `npm run test:pricing` (14 passing tests), admin `npm run build`, admin TypeScript check, and `git diff --check`.
