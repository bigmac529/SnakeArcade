# SnakeArcade production setup: database, secrets, email

This is what the server needs before the accounts version of SnakeArcade can run on the socha3 Windows/IIS host. The checklist at the end is the short version.

What changes compared to the old version:

- Players now have **accounts** (email + password + display name, email confirmation). Accounts, sessions and scores live in a **SQL Server** database instead of `data\settings.json`.
- The site sends **email** (confirmation and password-reset links) through the socha3.com mailbox over SMTP.
- The service needs a few **secrets**: a session secret, the database password(s), the SMTP password. They live in one env file on the server, outside the web folder, never in the repo.
- The old `data\settings.json` is no longer read or written. It stays where it is (the deploy still backs it up). Importing its scores is optional (see [Old leaderboard](#6-old-leaderboard-optional)).

## 1. SQL Server

**Version:** SQL Server 2016 or newer (2012 is the technical minimum: the app uses `OFFSET … FETCH`). Any edition, Express is fine. The app connects over TCP with a SQL login (the Node `tedious` driver); Windows authentication is possible too (see [Windows authentication](#windows-authentication-optional)).

**Database:** create an empty database named `SnakeArcade` (any name works; set `DB_NAME` or put it in the connection string). Default collation is fine: the app stores lowercased copies of emails/names for its unique keys, so uniqueness is case-insensitive whatever the collation.

**Logins.** Two options:

- **A. Least privilege (recommended).** Two logins:
  - `snakearcade_app` (used by the running site): `db_datareader` + `db_datawriter` on `SnakeArcade`. Nothing else.
  - `snakearcade_migrator` (used only to create/alter tables when a new version has migrations): `db_ddladmin` + `db_datareader` + `db_datawriter` on `SnakeArcade`.
- **B. Simple.** One login with `db_ddladmin` + `db_datareader` + `db_datawriter`, used for both.

Example T-SQL for option A (run as an admin; replace the passwords with long random ones):

```sql
CREATE DATABASE SnakeArcade;
GO
CREATE LOGIN snakearcade_app WITH PASSWORD = N'<long random password 1>', CHECK_POLICY = ON;
CREATE LOGIN snakearcade_migrator WITH PASSWORD = N'<long random password 2>', CHECK_POLICY = ON;
GO
USE SnakeArcade;
CREATE USER snakearcade_app FOR LOGIN snakearcade_app;
CREATE USER snakearcade_migrator FOR LOGIN snakearcade_migrator;
ALTER ROLE db_datareader ADD MEMBER snakearcade_app;
ALTER ROLE db_datawriter ADD MEMBER snakearcade_app;
ALTER ROLE db_ddladmin   ADD MEMBER snakearcade_migrator;
ALTER ROLE db_datareader ADD MEMBER snakearcade_migrator;
ALTER ROLE db_datawriter ADD MEMBER snakearcade_migrator;
GO
```

SQL Server must allow **SQL Server authentication** (mixed mode) for SQL logins, and **TCP/IP** must be enabled in SQL Server Configuration Manager.

**Network:** if SQL Server runs on the same machine as the site, use `Server=localhost` (or `localhost\INSTANCENAME`) and nothing is exposed. If it's on another machine, allow TCP 1433 (or the instance's fixed port) **only from the web server's IP** in the firewall; never open 1433 to the internet. Named instances on a dynamic port also need UDP 1434 (SQL Browser); a fixed port is simpler.

**Encryption:** the app connects with `Encrypt=true`. If SQL Server uses its self-signed certificate, also set `TrustServerCertificate=true` (acceptable when SQL Server is on the same machine or a trusted private network); with a proper certificate leave it `false`.

**Backups:** include `SnakeArcade` in the normal SQL Server backups. It holds accounts (emails, password hashes) and scores.

### Connection strings

The app's connection string (tedious, ADO.NET style):

```
Server=localhost,1433;Database=SnakeArcade;User Id=snakearcade_app;Password=<password 1>;Encrypt=true;TrustServerCertificate=true
```

The migration login, same format with its own user/password, goes in `DB_MIGRATION_CONNECTION_STRING`. For a named instance use `Server=localhost\SQLEXPRESS` (drop `,1433`). Put a password that contains `;` in braces: `Password={pa;ss}`.

Instead of a connection string you can set the parts: `DB_SERVER`, `DB_PORT` or `DB_INSTANCE`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_ENCRYPT`, `DB_TRUST_SERVER_CERTIFICATE`.

### Windows authentication (optional)

To use the service account's Windows identity instead of SQL logins: `npm install msnodesqlv8` in the app folder (needs the "ODBC Driver 17/18 for SQL Server"), set `DB_MSSQL_DRIVER=msnodesqlv8` and an ODBC connection string such as `Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=SnakeArcade;Trusted_Connection=yes;TrustServerCertificate=yes`, and grant the service account the roles above. SQL logins with the default driver need no extra install.

## 2. Secrets and settings: the env file

Create a folder **outside** the web root, for example `C:\WebApps\SnakeArcade-config\`, and in it `snakearcade.env`:

```ini
NODE_ENV=production
PORT=3105
HOST=localhost
PUBLIC_BASE_URL=https://snakearcade.socha3.com

# 48 random bytes, base64. Changing it later signs everyone out.
SESSION_SECRET=<generate, see below>

DB_CLIENT=mssql
DB_CONNECTION_STRING=Server=localhost,1433;Database=SnakeArcade;User Id=snakearcade_app;Password=<password 1>;Encrypt=true;TrustServerCertificate=true
# Option A (least privilege): the site never creates tables itself.
DB_MIGRATE_ON_START=false
# Option B (one login): leave DB_MIGRATE_ON_START out (defaults to true).

SMTP_HOST=<socha3.com mail provider's SMTP host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@socha3.com
SMTP_PASSWORD=<mailbox password or app password>
MAIL_FROM=SnakeArcade <no-reply@socha3.com>
```

Generate `SESSION_SECRET` (either one):

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

**File permissions:** only Administrators, SYSTEM, the account the `SnakeArcadeNode` service runs as, and the GitHub runner's service account (the deploy runs migrations with it) should be able to read the file. For example:

```powershell
icacls C:\WebApps\SnakeArcade-config /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "<service account>:(OI)(CI)R" "<runner account>:(OI)(CI)R"
```

**Tell the service where the file is.** In the WinSW config `C:\Tools\WinSW\SnakeArcadeNode.xml`, inside `<service>`:

```xml
<env name="SNAKEARCADE_ENV_FILE" value="C:\WebApps\SnakeArcade-config\snakearcade.env" />
```

Then reload the service definition (`SnakeArcadeNode.exe refresh`, or stop / `uninstall` / `install` / start) and restart it. (Alternatively each setting can be its own `<env name="…" value="…"/>` line in the WinSW XML; real environment variables win over the file. The file is easier to keep out of logs and backups of the XML.)

The deploy workflow passes the same path to `scripts\deploy.ps1` (`ENV_FILE` in `.github/workflows/deploy.yml`, default `C:\WebApps\SnakeArcade-config\snakearcade.env`). The deploy never copies, overwrites or deletes `.env` / `*.env` files or `data\`.

The service refuses to start (and logs why, without printing secrets) if `SESSION_SECRET` is missing or short in production, or if the database settings are incomplete.

## 3. Email through the socha3.com mailbox

The site sends two kinds of email: "Confirm your email" after sign-up (link valid 24 hours) and "Reset your password" (link valid 60 minutes). It uses standard authenticated SMTP with TLS, so any mailbox on socha3.com works.

- **Sender address:** a dedicated mailbox **`no-reply@socha3.com`** is suggested, so the site's mail is separate from personal mail and its password can be rotated independently. Using the existing socha3.com mailbox also works: set `SMTP_USER` to it, and `MAIL_FROM` to it or to an alias the provider lets that mailbox send as. Most providers reject or rewrite a From address the login isn't allowed to send as.
- **Server / port / security** (from the mail provider's settings page):
  - port **587** with STARTTLS: `SMTP_PORT=587`, `SMTP_SECURE=false` (the app still requires TLS; it never sends in plain text), or
  - port **465** with TLS: `SMTP_PORT=465`, `SMTP_SECURE=true`.
- **Login:** `SMTP_USER` (usually the full address) and `SMTP_PASSWORD`. If the mailbox has 2-factor sign-in, the provider may require an **app password** for SMTP, and SMTP AUTH may need to be switched on for that mailbox (for example, Microsoft 365 disables it per mailbox by default).
- **Secret:** the SMTP password goes only in the server env file. Never in the repo, the workflow, or a ticket.
- **Replies:** optional `MAIL_REPLY_TO` (for example a monitored address). Otherwise replies go to the no-reply mailbox.
- **Outbound firewall:** the web server must be able to reach the SMTP host on 587 (or 465).

### SPF / DKIM / DMARC for socha3.com

So the emails reach inboxes and not spam, the socha3.com DNS (Cloudflare) needs:

- **SPF:** one TXT record on `socha3.com` that includes the mail provider, e.g. `v=spf1 include:<provider's SPF domain> ~all`. There must be only **one** SPF record; if one exists, add the provider's `include:` to it rather than creating a second.
- **DKIM:** turn on DKIM signing for socha3.com in the mail provider's admin panel and publish the record(s) it shows (CNAME or TXT at `<selector>._domainkey.socha3.com`). Mail records in Cloudflare must be **DNS only** (grey cloud).
- **DMARC (recommended):** TXT at `_dmarc.socha3.com`, start with monitoring only: `v=DMARC1; p=none; rua=mailto:<address for reports>`. Tighten to `p=quarantine` once reports show SPF/DKIM passing.

**Check:** after setup, sign up on the site with a real address (Gmail works well) and use "Show original": `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. Don't forget spam folders during the first test.

`/api/health` shows `"mail":"smtp"` once `SMTP_HOST` is set (`"outbox"` means emails are only written to `data\outbox\` and nobody receives them; the log warns about this in production). Failed sends are logged with a masked address (`n***@example.com`) and the reason; players can use **Resend email** after a minute.

## 4. Migrations (creating the tables)

The schema is created by versioned migration files (`migrations\mssql\*.sql`), recorded in the table `dbo.schema_migrations`. Each runs in a transaction; running again does nothing.

- **Option A (least privilege):** run migrations with the migrator login whenever a release adds one (the first time: now). In PowerShell on the server, from the app folder:

  ```powershell
  cd C:\WebApps\SnakeArcade
  $env:SNAKEARCADE_ENV_FILE = "C:\WebApps\SnakeArcade-config\snakearcade.env"
  $env:DB_MIGRATION_CONNECTION_STRING = "Server=localhost,1433;Database=SnakeArcade;User Id=snakearcade_migrator;Password=<password 2>;Encrypt=true;TrustServerCertificate=true"
  npm run migrate
  Remove-Item Env:DB_MIGRATION_CONNECTION_STRING
  ```

  (Or put `DB_MIGRATION_CONNECTION_STRING` in the env file, which is simpler but gives the running site DDL credentials too.) `npm run migrate -- --check` lists pending migrations without changing anything.

  Deploys also run `npm run migrate` from the checkout before switching versions. With only the app login that step succeeds when nothing is pending, and **fails safely** when a release needs a migration: the old version keeps running, nothing is copied. Run the command above, then re-run the deploy (Actions > Deploy > Run workflow).

- **Option B (one login):** nothing to do. The deploy and the service apply pending migrations automatically.

The service refuses to start while migrations are pending, and says so in its log.

## 5. First deploy and verification

1. Do sections 1-4 (checklist below).
2. Merge the pull request (or run Actions > Deploy). The deploy runs migrations, mirrors the files (keeping `data\`, `web.config`, env files), restarts `SnakeArcadeNode` and checks `/api/health` locally and publicly.
3. Check `https://snakearcade.socha3.com/api/health` shows `"db":"mssql"` and `"mail":"smtp"`.
4. Sign up with a real address, confirm via the email, play a game, and check the score on the board. Try **Forgot password?** once.
5. Look at the service log (WinSW `SnakeArcadeNode.out.log` / `.err.log`) for `[config]`, `[db]` or `[mail]` errors.

## 6. Old leaderboard (optional)

The old name-only scores in `C:\WebApps\SnakeArcade\data\settings.json` are not used by the new version. To show them on the new board, tagged **legacy** and not tied to any account (nobody can claim them):

```powershell
cd C:\WebApps\SnakeArcade
$env:SNAKEARCADE_ENV_FILE = "C:\WebApps\SnakeArcade-config\snakearcade.env"
npm run import-legacy -- --dry-run   # list what would be imported
npm run import-legacy                # import (safe to re-run: replaces, no duplicates)
npm run import-legacy -- --clear     # remove them again
```

Players with a best of 0 and names that fail the PG filter are skipped. Whether to import at all is Michael's call.

## Checklist (Sissy)

- [ ] SQL Server 2016+ reachable from the web server (same machine preferred; otherwise TCP 1433 allowed only from the web server). TCP/IP and SQL authentication enabled.
- [ ] Database `SnakeArcade` created and included in backups.
- [ ] Logins: `snakearcade_app` (db_datareader + db_datawriter) and `snakearcade_migrator` (db_ddladmin + db_datareader + db_datawriter), or one login with all three (option B). Long random passwords.
- [ ] Folder `C:\WebApps\SnakeArcade-config\` created outside the web root, ACL: Administrators, SYSTEM, service account, runner account only.
- [ ] `snakearcade.env` written there: `NODE_ENV=production`, `PORT=3105`, `HOST=localhost`, `PUBLIC_BASE_URL=https://snakearcade.socha3.com`, `SESSION_SECRET` (generated, 32+ chars), `DB_CLIENT=mssql`, `DB_CONNECTION_STRING`, `DB_MIGRATE_ON_START=false` (option A), `SMTP_*`, `MAIL_FROM`.
- [ ] WinSW `SnakeArcadeNode.xml`: `<env name="SNAKEARCADE_ENV_FILE" value="C:\WebApps\SnakeArcade-config\snakearcade.env" />` added, service definition refreshed.
- [ ] Mailbox `no-reply@socha3.com` created (or the existing mailbox chosen), SMTP AUTH enabled for it, app password if needed. SMTP host / port (587 STARTTLS or 465 TLS) noted in the env file. Outbound 587/465 allowed from the server.
- [ ] socha3.com DNS: SPF includes the mail provider (single SPF record), DKIM enabled and published, DMARC `p=none` to start.
- [ ] Migrations applied with the migrator login (`npm run migrate`, section 4), or option B chosen.
- [ ] PR merged / deploy run green. `/api/health` shows `"db":"mssql"` and `"mail":"smtp"`.
- [ ] Test sign-up with a real address: confirmation email arrives (not in spam), SPF/DKIM/DMARC pass, game + board work, password reset works.
- [ ] (Optional, if Michael wants it) old scores imported with `npm run import-legacy`.
