# EOD Bot — Setup Guide

A Slack slash command bot that auto-generates EOD reports from Connie Tasks. Type `/eod` and instantly see:
- ✅ Tasks completed in the last 24h
- 📝 Tickets you created in the last 24h
- 🔄 Tickets in progress
- 🎯 Top 5 upcoming tasks by priority

> Built by a product manager with AI as the pair-programmer. Runs in production on Render.
> Stack: Node.js · Slack Block Kit · Connie Tool API · Render.

---

## Step 1: Get your Connie API key and workspace ID

1. In Connie, open **Settings → Developers → API keys**
2. Click **"Generate API key"**, name it `EOD Bot`, and copy it — it starts with `sk_`
3. The key acts as the member it is linked to (**Permissions of [member]**), so link it to a
   non-guest member who can read the team's Tasks
4. Copy your workspace ID: the UUID right after `connie.ai/` in the app's address

The bot reads Tasks and members through the [Tool API](https://docs.connie.ai/developers/tool-api)
(`object-search-tasks`, `workspace-list-members`). Both are reads and cost no credits.

---

## Step 2: Create your Slack App

1. Go to **https://api.slack.com/apps** → Click **"Create New App"**
2. Choose **"From scratch"**
3. Name it `EOD Bot`, pick your workspace → Click **"Create App"**

### Add Bot Scopes
4. In the left sidebar → **"OAuth & Permissions"**
5. Scroll to **"Scopes" → "Bot Token Scopes"** → Add these:
   - `commands` — to receive slash commands
   - `users:read` — to look up users
   - `users:read.email` — to get user emails (needed to match Connie members)
   - `chat:write` — to post messages

### Install the App
6. Scroll up → Click **"Install to Workspace"** → Allow
7. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — save it

---

## Step 3: Deploy to Render

1. Push this code to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "Initial EOD bot"
   # Create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/eod-bot.git
   git push -u origin main
   ```
2. Go to **https://render.com** → Sign up with GitHub
3. Click **"New +"** → **"Web Service"** → connect your GitHub repo
4. Configure the service:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Scroll to **"Environment Variables"** → Add these:
   ```
   CONNIE_API_KEY       = sk_your_key_here
   CONNIE_WORKSPACE_ID  = your-workspace-uuid
   SLACK_BOT_TOKEN      = xoxb-your-token-here
   ```
6. Click **"Create Web Service"** — Render builds and deploys automatically
7. Copy your Render URL, e.g. `https://eod-bot.onrender.com`

---

## Step 4: Create the Slash Command in Slack

1. Go back to **https://api.slack.com/apps** → Your app
2. Left sidebar → **"Slash Commands"** → **"Create New Command"**
3. Fill in:
   - **Command:** `/eod`
   - **Request URL:** `https://YOUR-RENDER-URL.onrender.com/eod`
   - **Short Description:** `Generate your EOD report from Connie`
   - **Usage Hint:** _(leave blank)_
4. Click **"Save"**
5. You'll be prompted to **reinstall the app** — do it

---

## Step 5: Test it!

Go to any Slack channel and type `/eod` — you should see your EOD report appear!

---

## Morning plan (scheduled)

> **Disabled.** `morning.js` exits without posting unless `MORNING_ENABLED=1` is set
> on the Cron Job. `DRY_RUN=1` still prints the message to the logs.

`morning.js` posts one message each weekday morning with every listed developer's
in-progress Connie tasks and their next 3 tasks. It flags anyone with nothing in
progress, nothing in Todo, or more than 3 tickets in progress, and marks in-progress
tickets with no update in 2 working days. It runs as a separate Render Cron Job, so
the `/eod` web service is unaffected.

"Next" comes only from **To do**, highest priority first, then the oldest ticket.
Backlog, Triage and **In review** tasks are left out.

1. Invite the bot to the channel (`/invite @EOD Bot`). Private channels need this.
2. In Render: **New +** → **Cron Job** → connect this repo, branch `main`.
   - **Build Command:** `npm install`
   - **Command:** `npm run morning`
   - **Schedule:** `30 4 * * 1-5` (Render uses UTC; this is 10:00 IST, Mon–Fri)
3. Add environment variables (or attach an environment group shared with the web service):
   ```
   CONNIE_API_KEY       = same as the web service
   CONNIE_WORKSPACE_ID  = same as the web service
   SLACK_BOT_TOKEN  = same as the web service
   MORNING_CHANNEL  = channel ID, e.g. C0123456789
   MORNING_DEVS     = comma-separated emails, the same in Slack and Connie
   ```
4. To check it without posting, add `DRY_RUN=1`, click **Trigger Run** on the Runs
   page, and read the logs. Remove `DRY_RUN` when it looks right.

Render bills a Cron Job by run time, with a $1/month minimum.

### Known gap: review and completion times

Connie records when a task moved into **In review** (`review_requested_at`) and when it was
completed, but the Tool API's task list does not return those times yet. Until it does, `/eod`
uses each task's last update instead: nothing moved in the last 24h is missed, but a task that was
already in review or done and was edited in the last 24h also counts as done today. The bot reads
`reviewRequestedAt` and `completedAt` automatically as soon as Connie returns them.

---

## Troubleshooting

**"No Connie member found for..."**
→ Your Slack email must match your Connie login email, and you must be a member of the workspace
the API key belongs to (check **Settings → Members**).

**"Couldn't retrieve your Slack email"**
→ Make sure you added the `users:read.email` scope and reinstalled the app.

**Bot doesn't respond**
→ Check your Render logs (open your service → "Logs") for errors.

**Empty completed/in-progress lists**
→ Make sure you're assigned to tasks in Connie and they were updated today.

---

## Local Development (optional)

```bash
npm install
cp .env.example .env
# Fill in .env with your real values

# Install ngrok for local tunneling
npx ngrok http 3000

# Set your slash command Request URL to the ngrok URL + /eod
# Then run:
npm run dev
```

---

## How it works

When you type `/eod`, Slack sends a POST to your server. The bot:
1. Gets your Slack email via the Slack API
2. Finds your matching Connie member by email (Connie compares the full address on its server)
3. Queries Connie Tasks for tasks completed or created in the last 24h, what's in progress, and your top 5 upcoming
4. Formats everything into a Slack Block Kit message posted to the channel
