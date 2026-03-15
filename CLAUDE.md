---
last modified: 2026-02-14T00:00:00+08:00
---
[[claude-code]]

# Agent Instructions
You're working inside the **WAT framework** (Workflows, Agents, Tools). This architecture separates concerns so that probabilistic AI handles reasoning while deterministic code handles execution. That separation is what makes this system reliable.

## The WAT Architecture

**Layer 1: Workflows (The Instructions)**
- Markdown SOPs stored in `workflows/`
- Each workflow defines the objective, required inputs, which tools to use, expected outputs, and how to handle edge cases
- Written in plain language, the same way you'd brief someone on your team

**Layer 2: Agents (The Decision-Maker)**
- This is your role. You're responsible for intelligent coordination.
- Read the relevant workflow, run tools in the correct sequence, handle failures gracefully, and ask clarifying questions when needed
- You connect intent to execution without trying to do everything yourself
- Example: If you need to process form responses, don't attempt it directly. Read `workflows/process_form_responses.md`, figure out the required inputs, then execute the appropriate Apps Script function

**Layer 3: Tools (The Execution)**
- Google Apps Script files (`.js`) that do the actual work
- Google Workspace integration (Sheets, Forms, Gmail, Drive, etc.)
- API calls, data transformations, spreadsheet operations
- Credentials handled through Google OAuth and PropertiesService
- These scripts are consistent, testable, and fast

**Why this matters:** When AI tries to handle every step directly, accuracy drops fast. If each step is 90% accurate, you're down to 59% success after just five steps. By offloading execution to deterministic scripts, you stay focused on orchestration and decision-making where you excel.

## How to Operate

**1. Look for existing tools first**
Before building anything new, check existing `.js` files based on what your workflow requires. Only create new scripts when nothing exists for that task.

**2. Learn and adapt when things fail**
When you hit an error:
- Read the full error message and execution logs
- Fix the script and retest (watch for quota limits: emails, URL fetches, execution time)
- Document what you learned in the workflow (rate limits, timing quirks, unexpected behavior)
- Example: You hit the 6-minute execution limit, so you refactor to use batch operations, add a continuation trigger for long-running tasks, verify it works, then update the workflow so this never happens again

**3. Keep workflows current**
Workflows should evolve as you learn. When you find better methods, discover constraints, or encounter recurring issues, update the workflow. That said, don't create or overwrite workflows without asking unless I explicitly tell you to. These are your instructions and need to be preserved and refined, not tossed after one use.

## The Self-Improvement Loop

Every failure is a chance to make the system stronger:
1. Identify what broke
2. Fix the tool
3. Verify the fix works
4. Update the workflow with the new approach
5. Move on with a more robust system
This loop is how the framework improves over time.

## File Structure

**What goes where:**
- **Deliverables**: Final outputs go to cloud services (Google Sheets, Slides, Docs, etc.) where they can be accessed directly
- **Scripts**: Apps Script files (`.js`) for deterministic execution
- **UI**: HTML files for dialogs, sidebars, and web apps

**Directory/file layout:**
```
workflows/           # Markdown SOPs defining what to do and how
Config.js            # Centralized configuration (DATABASE_FOLDER_ID, ADMIN_EMAILS, etc.)
*.js                 # Apps Script server-side code (tools layer)
*.html               # Client-side UI templates
appsscript.json      # Project manifest (OAuth scopes, timezone, etc.)
```

**IMPORTANT - Configuration Pattern:**
- **NEVER hardcode configuration values** in code files (except non-sensitive defaults in Config.js)
- **ALL configuration goes in Config.js**; deploy-specific or sensitive values can override via Script Properties (File > Project properties > Script properties)
- Use Config.js helpers: `getConfig(key)` (returns Script Property or APP_CONFIG fallback), `getConfigValue(key)` (same, with empty string fallback), `isAdmin()` (checks Session.getActiveUser().getEmail() against Script Property ADMIN_EMAILS, comma-separated; empty = allow all)
- When adding new config values:
  1. Add constant to APP_CONFIG in Config.js
  2. If overridable per deploy, use getConfigValue('KEY') in code; optional: set Script Property KEY to override
  3. Create helper function if needed (e.g. isAdmin for guarding sensitive operations)
  4. Update this documentation
- Sensitive operations (e.g. Fetch for all clients, Client Management save) are guarded with isAdmin(); set ADMIN_EMAILS in Script Properties to restrict

**Data storage:**
- **Persistent data**: Google Sheets, Drive, PropertiesService
- **Temporary data**: PropertiesService (with expiration), CacheService (6 hours max)
- **Configuration**: Centralized in Config.js (NO hardcoded values elsewhere)
- **Database location**: Defined in Config.js as `DATABASE_FOLDER_ID`
- **Database creation**: Only admins can create/initialize database (prevents students from recreating)
- **Admin users**: Defined in Config.js as `ADMIN_EMAILS` array

**Core principle:** Data lives in Google Workspace services. Apps Script code orchestrates operations across these services. Everything is cloud-native.

**Database Management Pattern:**
- Check if database exists in folder before creating (search by name)
- Never replace existing database - reuse if found
- Use admin-only access control for database initialization via `isAdmin()` check
- Store database in specific folder (DATABASE_FOLDER_ID), not in root drive
- Auto-detect existing database by name in folder to avoid duplicates
- Move newly created files to folder and remove from root to keep organized

## Apps Script Development Guidelines

**Environment constraints:**
- JavaScript ES5+ (limited ES6 support - no modules, imports)
- Server-side execution (Google servers, not browser)
- 6-minute timeout for simple triggers, 30 minutes for installable triggers
- Quotas on emails, URL fetches, execution time, and service calls

**Best practices:**
- Batch operations to avoid quota limits (`getValues()`/`setValues()` instead of loops)
- Use `Logger.log()` for debugging (View > Logs in Apps Script editor)
- Cache service references (spreadsheet, range) for performance
- Handle errors gracefully - users see your error messages
- Use PropertiesService for config, CacheService for temporary data

**Key Apps Script services:**
- `SpreadsheetApp` - Sheets operations
- `FormApp` - Forms creation/management
- `GmailApp`/`MailApp` - Email sending
- `HtmlService` - Web apps and UI
- `UrlFetchApp` - External API calls
- `Utilities` - Encoding, formatting, UUIDs

**Working with HTML:**
- **IMPORTANT**: Use `createTemplateFromFile().evaluate()` instead of `createHtmlOutputFromFile()` when pages need to include other HTML files
- The web app entry point `doGet()` and the helper `include(filename)` live in WebApp.js (not Code.js). Use `include()` for HTML partials (like Styles.html).
- In HTML templates, use `<?!= include('Filename') ?>` to include other HTML files (NOT `HtmlService.createHtmlOutputFromFile()`)
- **Best Practice**: Centralize styles in a dedicated `Styles.html` and include it in all pages using `<?!= include('Styles') ?>`
- Use `google.script.run` to call server functions from client
- Always handle `.withSuccessHandler()` and `.withFailureHandler()`

**Debugging and Testing Pattern:**
- **Create TestFunctions.js** for manual testing from Apps Script editor
- Include diagnostic functions that can be run directly:
  - `quickDiagnosis()` - Fast check of system status (database, admin, APIs)
  - `runAllTests()` - Complete test suite
  - Individual test functions for each component
- **Frontend debugging**: Add visual status indicators showing data loading state
  - Use emoji markers in console logs (🔄 Loading, ✅ Success, ❌ Failed)
  - Display loading status prominently in UI with color-coded messages
  - Update status in real-time as data loads or fails
- **Test functions should:**
  - Use Logger.log() with clear success/failure indicators
  - Test the exact API functions that the frontend calls
  - Provide actionable error messages and solutions
  - Check prerequisites (admin status, database exists, etc.)
- **Create comprehensive DEBUG_STEPS.md** with troubleshooting guide
- Backend tests catch issues before frontend testing (faster feedback loop)

## Bottom Line

You sit between what I want (workflows) and what actually gets done (tools). Your job is to read instructions, make smart decisions, call the right tools, recover from errors, and keep improving the system as you go.

When working with Apps Script: respect quota limits, batch your operations, handle errors explicitly, and always test before deploying.

Stay pragmatic. Stay reliable. Keep learning.